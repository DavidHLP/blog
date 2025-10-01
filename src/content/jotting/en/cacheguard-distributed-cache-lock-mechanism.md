---
title: "CacheGuard Distributed Cache Lock Mechanism Development Log"
description: Detailed introduction to CacheGuard's two-tier lock mechanism design and implementation, including coordination between JVM internal locks and distributed locks
timestamp: 2025-10-01 14:30:00+08:00
series: CacheGuard Development Records
contents: true
tags: ["distributed-lock", "cache", "Redis", "Java", "concurrency-control"]
---

## I. System Architecture Overview

### 1.1 Overall Design Philosophy

CacheGuard implements a two-tier lock mechanism to prevent cache breakdown issues:

- **First Tier**: JVM Internal Lock (InternalLockSupport) - Based on ReentrantLock
- **Second Tier**: Distributed Lock (DistributedLockSupport) - Based on Redisson RLock

### 1.2 Core Component Relationships

```
SyncSupport (Core Coordinator)
├── InternalLockSupport (Local Lock Layer)
│   ├── LockWrapper (Lock Wrapper)
│   ├── ReentrantLock (JVM Lock)
│   └── EvictionStrategy (Lock Eviction Strategy)
└── DistributedLockSupport (Distributed Lock Layer)
    └── RedissonClient (Redis Distributed Lock)
```

## II. Core Implementation Analysis

### 2.1 Lock Wrapper (LockWrapper.java)

**File Location**: `SyncSupport.java:16-19`, `LockWrapper.java:7-20`

**Design Goals**:

- Encapsulate ReentrantLock and provide eviction capability assessment
- Prevent active locks from being evicted, which could cause deadlocks

**Core Implementation**:

```java
public class LockWrapper {
    private final ReentrantLock lock;

    // Determine if lock can be evicted: not held && no waiting threads
    public boolean canEvict() {
        return !lock.isLocked() && !lock.hasQueuedThreads();
    }
}
```

**Key Design Points**:

1. `isLocked()`: Check if the lock is held
2. `hasQueuedThreads()`: Check if there are threads in the waiting queue
3. Only allow eviction when both conditions are `false`

### 2.2 Local Lock Support (InternalLockSupport)

**File Location**: `SyncSupport.java:216-370`

#### 2.2.1 Initialization Configuration

```java
// Default configuration (SyncSupport.java:232-233)
maxActiveSize: 1024   // Active lock capacity
maxInactiveSize: 512  // Inactive lock capacity
```

#### 2.2.2 Lock Eviction Strategy

```java
// Use double-linked list eviction strategy (SyncSupport.java:238-240)
this.lockStrategy = EvictionStrategyFactory.createTwoListWithPredicate(
    maxActiveSize,
    maxInactiveSize,
    LockWrapper::canEvict  // Eviction predicate
);
```

**Eviction Algorithm**:

- **Active List**: Stores recently accessed locks (67% capacity)
- **Inactive List**: Stores inactive locks (33% capacity)
- **Eviction Condition**: Only evict locks that satisfy `canEvict()`

#### 2.2.3 Lock Acquisition Flow

```java
// SyncSupport.java:287-299
public LockWrapper tryAcquire(String key, long timeoutSeconds)
        throws InterruptedException {

    LockWrapper wrapper = getOrCreateLock(key);  // Get or create lock
    ReentrantLock lock = wrapper.getLock();

    boolean acquired = lock.tryLock(timeoutSeconds, TimeUnit.SECONDS);
    if (acquired) {
        return wrapper;  // Acquisition successful
    }
    return null;  // Timeout failure
}
```

#### 2.2.4 Lock Creation Logic

```java
// SyncSupport.java:318-329
private LockWrapper getOrCreateLock(String key) {
    LockWrapper wrapper = lockStrategy.get(key);
    if (wrapper != null) {
        return wrapper; // Reuse existing lock
    }

    // Create new lock and put into eviction strategy
    LockWrapper newWrapper = new LockWrapper();
    lockStrategy.put(key, newWrapper);
    return newWrapper;
}
```

**Key Features**:

1. **Lock Object Reuse**: Same key reuses lock object
2. **Automatic Eviction**: Evict unused locks when capacity exceeded
3. **Thread Safety**: Eviction strategy ensures internal thread safety

### 2.3 Distributed Lock Support (DistributedLockSupport)

**File Location**: `SyncSupport.java:89-214`

#### 2.3.1 Lock Key Design

```java
// SyncSupport.java:105
private static final String LOCK_PREFIX = "cache:lock:";

// Complete key format: cache:lock:{cacheKey}
```

#### 2.3.2 Lock Acquisition Implementation

```java
// SyncSupport.java:159-171
public RLock tryAcquire(String key, long timeoutSeconds)
        throws InterruptedException {

    String lockKey = LOCK_PREFIX + key;
    RLock lock = redissonClient.getLock(lockKey);

    // tryLock(wait time, lease time, time unit)
    // leaseTime = -1 enables watchdog auto-renewal
    boolean acquired = lock.tryLock(timeoutSeconds, -1, TimeUnit.SECONDS);

    return acquired ? lock : null;
}
```

**Redisson Feature Application**:

1. **Watchdog Mechanism**: `leaseTime = -1` enables auto-renewal
2. **Reentrancy**: Supports multiple acquisitions by the same thread
3. **Cluster Support**: Supports Redis master-slave/sentinel/cluster modes

#### 2.3.3 Lock Release Logic

```java
// SyncSupport.java:179-188
public void release(RLock lock, String key) {
    // Only release locks held by current thread
    if (lock != null && lock.isHeldByCurrentThread()) {
        try {
            lock.unlock();
        } catch (Exception e) {
            log.error("Failed to release distributed lock for key: {}", key, e);
        }
    }
}
```

**Safety Checks**:

- `isHeldByCurrentThread()`: Prevent releasing locks held by other threads
- **Exception Handling**: Avoid business interruption due to unlock failures

### 2.4 Two-Tier Lock Coordinator (SyncSupport)

**File Location**: `SyncSupport.java:18-87`

#### 2.4.1 Complete Execution Flow

```java
// SyncSupport.java:40-86
public <T> T executeSync(String key, Supplier<T> loader, long timeoutSeconds) {
    LockWrapper internalLock = null;
    RLock distributedLock = null;

    try {
        // First tier: Acquire local lock
        internalLock = internalLockSupport.tryAcquire(key, timeoutSeconds);
        if (internalLock == null) {
            log.warn("Failed to acquire internal lock");
            return loader.get();  // Fallback: Execute directly
        }

        // Second tier: Acquire distributed lock
        distributedLock = distributedLockSupport.tryAcquire(key, timeoutSeconds);
        if (distributedLock == null) {
            log.warn("Failed to acquire distributed lock");
            return loader.get();  // Fallback: Execute directly
        }

        // Hold both locks, execute data loading
        return loader.get();

    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        return loader.get();  // Fallback handling

    } finally {
        // Release outer lock first (distributed lock)
        if (distributedLock != null) {
            distributedLockSupport.release(distributedLock, key);
        }
        // Then release inner lock (local lock)
        if (internalLock != null) {
            internalLockSupport.release(internalLock, key);
        }
    }
}
```

#### 2.4.2 Key Design Principles

1. **Lock Acquisition Order**:
    - Local lock → Distributed lock
    - **Reason**: Local locks have low overhead, filter same-JVM concurrency first

2. **Lock Release Order**:
    - Distributed lock → Local lock
    - **Reason**: Release outer lock first to avoid blocking other nodes

3. **Fallback Strategy**:
    - Lock acquisition failure → Don't block requests, execute loader directly
    - Interrupt exception → Restore interrupt state, execute loader
    - **Purpose**: Ensure availability, avoid service unavailability due to lock failures

## III. Business Integration Points

### 3.1 Cache Read Integration (RedisProCacheWriter.java)

#### 3.1.1 Sync Mode Detection

```java
// RedisProCacheWriter.java:93-104
public byte[] get(String name, byte[] key, Duration ttl) {
    String redisKey = writerChainableUtils.TypeSupport().bytesToString(key);
    String actualKey = extractActualKey(name, redisKey);

    // Check if sync mode is enabled
    RedisCacheableOperation cacheOperation =
        redisCacheRegister.getCacheableOperation(name, actualKey);

    if (cacheOperation != null && cacheOperation.isSync()) {
        return getWithSync(name, redisKey, actualKey, ttl, cacheOperation);
    }

    return getNormal(name, redisKey, actualKey, ttl, cacheOperation);
}
```

#### 3.1.2 Synchronized Read Implementation

```java
// RedisProCacheWriter.java:107-120
private byte[] getWithSync(...) {
    return writerChainableUtils
        .SyncSupport()
        .executeSync(
            redisKey,
            () -> getNormal(...), // Loading logic on cache miss
            10 // Lock wait timeout 10 seconds
        );
}
```

### 3.2 Conditional Write Integration (putIfAbsent)

```java
// RedisProCacheWriter.java:283-296
public byte[] putIfAbsent(String name, byte[] key, byte[] value, Duration ttl) {
    RedisCacheableOperation cacheOperation =
        redisCacheRegister.getCacheableOperation(name, actualKey);

    if (cacheOperation != null && cacheOperation.isSync()) {
        return putIfAbsentWithSync(name, redisKey, value, ttl);
    }

    return putIfAbsentNormal(name, redisKey, value, ttl);
}
```

## IV. Testing Verification

### 4.1 Cache Breakdown Protection Test (SyncCacheTest.java)

**File Location**: `SyncCacheTest.java:54-89`

#### 4.1.1 Test Scenario

```java
@Test
@DisplayName("sync=true should prevent cache breakdown")
public void testSyncPreventsCachePenetration() throws InterruptedException {
    int threadCount = 10;
    CountDownLatch startLatch = new CountDownLatch(1);

    // 10 threads simultaneously request the same non-existent cache
    for (int i = 0; i < threadCount; i++) {
        executor.submit(() -> {
            startLatch.await();
            String result = syncCacheService.getUserName(1L);
            assertThat(result).isEqualTo("David-1");
        });
    }

    startLatch.countDown();  // Start all threads simultaneously
    endLatch.await(10, TimeUnit.SECONDS);

    // Verify: Method called only once
    assertThat(syncCacheService.getCallCount()).isEqualTo(1);
}
```

**Test Results**:

- ✅ 10 concurrent requests
- ✅ Actual method called only once
- ✅ Other 9 threads wait for first thread to complete loading

### 4.2 Cache Hit Test

**File Location**: `SyncCacheTest.java:91-123`

```java
@Test
@DisplayName("sync=true does not lock on cache hit")
public void testSyncDoesNotLockOnCacheHit() throws InterruptedException {
    // Warm up cache first
    syncCacheService.getUserName(2L);

    // 20 threads concurrent reading
    syncCacheService.resetCallCount();
    for (int i = 0; i < 20; i++) {
        executor.submit(() -> syncCacheService.getUserName(2L));
    }

    // Verify: Method call count is 0 (all hit cache)
    assertThat(syncCacheService.getCallCount()).isEqualTo(0);
}
```

**Test Results**:

- ✅ No locking on cache hit
- ✅ All 20 concurrent requests return directly
- ✅ No execution of actual business method

## V. Performance Optimization Design

### 5.1 Local Lock Pooling Mechanism

**Optimization Points**:

1. **Lock Object Reuse**: Same key reuses LockWrapper objects
2. **Automatic Eviction**: Use double-linked list LRU algorithm to evict cold locks
3. **Smart Eviction**: Only evict unheld locks

**Memory Usage Estimation**:

- Default configuration: 1024(Active) + 512(Inactive) = 1536 locks
- Each ReentrantLock ~48 bytes
- Total memory: 1536 × 48 = ~74 KB

### 5.2 Distributed Lock Optimization

**Watchdog Mechanism**:

```java
// leaseTime = -1 enables watchdog
lock.tryLock(timeoutSeconds, -1, TimeUnit.SECONDS);
```

**Advantages**:

- **Auto-renewal**: Prevent lock expiration due to long business execution time
- **Avoid Deadlock**: Auto-release when client crashes (default 30 seconds)

### 5.3 Fallback Strategy

**Design Philosophy**: Availability over consistency

**Fallback Scenarios**:

1. Local lock acquisition timeout → Execute directly
2. Distributed lock acquisition timeout → Execute directly
3. Thread interruption → Restore interrupt state, execute directly

**Impact Analysis**:

- **Worst Case**: Multiple nodes simultaneously load same data
- **Business Impact**: Increased database pressure, but service not interrupted
- **Applicable Scenarios**: Read-heavy cache scenarios

## VI. Logging Design

### 6.1 Log Level Strategy

**DEBUG Level** (Development/Troubleshooting):

```java
log.debug("Acquired internal lock for key: {}", key);
log.debug("Acquired distributed lock for key: {}", key);
log.debug("Released internal lock for key: {}", key);
```

**WARN Level** (Potential Issues):

```java
log.warn("Failed to acquire internal lock within {} seconds: {}", timeout, key);
log.warn("Failed to acquire distributed lock within {} seconds: {}", timeout, key);
```

**ERROR Level** (Exception Cases):

```java
log.error("Interrupted while waiting for lock on key: {}", key, e);
log.error("Failed to release lock for key: {}", key, e);
```

### 6.2 Log Encapsulation

**Example**:

```java
// SyncSupport.java:190-213
private void logAcquired(String key) {
    log.debug("Acquired distributed lock for key: {}", key);
}

private void logReleaseFailure(String key, Exception e) {
    log.error("Failed to release distributed lock for key: {}", key, e);
}
```

**Benefits**:

1. Unified log format
2. Easy to modify log content
3. Follows DRY principle

## VII. Best Practices Summary

### 7.1 Applicable Scenarios

✅ **Recommended Use**:

- Concentrated cache expiration times
- Long data loading time (>100ms)
- High database query overhead
- Multi-instance deployment environments

❌ **Not Recommended**:

- Extremely high cache hit rate (>99%)
- Extremely fast data loading (<10ms)
- Single instance deployment
- Scenarios with low consistency requirements

### 7.2 Configuration Recommendations

**Local Lock Pool Capacity**:

```java
// Adjust based on cache key count
maxActiveSize = cache key count × 0.1  // Take 10%
maxInactiveSize = maxActiveSize / 2
```

**Lock Timeout**:

```java
// Adjust based on business loading time
timeout = maximum business loading time × 2  // Leave 100% margin
Recommended range: 5-30 seconds
```

### 7.3 Monitoring Metrics

**Key Metrics**:

1. **Lock Acquisition Failure Rate**: `lock_acquire_failure_rate`
2. **Lock Wait Duration**: `lock_wait_duration`
3. **Lock Pool Hit Rate**: `lock_pool_hit_rate`
4. **Lock Pool Eviction Count**: `lock_eviction_count`

## VIII. Potential Risks and Improvements

### 8.1 Known Risks

1. **Fallback Strategy May Cause Cache Breakdown**
    - **Scenario**: All distributed locks fail to acquire
    - **Impact**: Large number of requests hit database directly
    - **Suggestion**: Add retry mechanism or circuit breaker

2. **Local Lock Eviction May Cause Concurrency**
    - **Scenario**: Lock evicted then recreated
    - **Impact**: Brief concurrency window
    - **Suggestion**: Increase lock pool capacity

### 8.2 Improvement Suggestions

1. **Add Lock Wait Queue Monitoring**:

    ```java
    public int getWaitingThreads(String key) {
        LockWrapper wrapper = lockStrategy.get(key);
        return wrapper != null ? wrapper.getLock().getQueueLength() : 0;
    }
    ```

2. **Support Custom Timeout Strategy**:

    ```java
    @RedisCacheable(
        sync = true,
        syncTimeout = 5,        // Local lock timeout
        distributedTimeout = 10 // Distributed lock timeout
    )
    ```

3. **Add Lock Competition Fallback Strategy**:

    ```java
    // When lock competition is intense, auto-fallback to bloom filter
    if (lockCompetitionRate > threshold) {
        useBloomFilter();
    }
    ```

## IX. Code Quality Assessment

### 9.1 Compliance Standards

✅ **Exception Handling**:

- Restore interrupt state after catching `InterruptedException`
- Use logging to record exceptions without affecting business flow

✅ **Logging Conventions**:

- Use SLF4J + Lombok `@Slf4j`
- Use placeholders for DEBUG level: `log.debug("{}", key)`
- Avoid string concatenation

✅ **DRY Principle**:

- Log method encapsulation
- Lock acquisition/release logic reuse

### 9.2 Improvement Areas

1. **NPE Protection**:

    ```java
    // Suggest adding @NonNull annotations
    public <T> T executeSync(@NonNull String key,
                            @NonNull Supplier<T> loader,
                            long timeoutSeconds)
    ```

2. **Resource Release**:

    ```java
    // Correctly released in finally block, compliant
    finally {
        if (distributedLock != null) {
            distributedLockSupport.release(distributedLock, key);
        }
        if (internalLock != null) {
            internalLockSupport.release(internalLock, key);
        }
    }
    ```

## X. Summary

CacheGuard's lock mechanism design embodies the following core ideas:

1. **Layered Design**: Local lock + distributed lock, filtering concurrency layer by layer
2. **Fallback Priority**: Ensure service availability when locks fail
3. **Resource Optimization**: Lock pooling + auto-eviction, control memory usage
4. **Observability**: Complete logging system for easy troubleshooting

**Core Value**:

- Effectively prevent cache breakdown
- Reduce database pressure
- Support multi-instance deployment
- Ensure high service availability

**Applicable Scenarios**: Read-heavy, time-consuming data loading, multi-instance deployed distributed cache systems
