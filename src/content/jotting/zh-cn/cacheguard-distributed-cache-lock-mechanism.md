---
title: "CacheGuard 分布式缓存锁机制开发日志"
description: 详细介绍 CacheGuard 两级锁机制的设计与实现，包括 JVM 内部锁和分布式锁的协调机制
timestamp: 2025-10-01 14:30:00+08:00
series: CacheGuard Development Records
contents: true
tags: ["分布式锁", "缓存", "Redis", "Java", "并发控制"]
---

## 一、系统架构概述

### 1.1 整体设计思路

CacheGuard 实现了两级锁机制来防止缓存击穿问题：

- **第一级**：JVM 内部锁 (InternalLockSupport) - 基于 ReentrantLock
- **第二级**：分布式锁 (DistributedLockSupport) - 基于 Redisson RLock

### 1.2 核心组件关系

```
SyncSupport (核心协调器)
├── InternalLockSupport (本地锁层)
│   ├── LockWrapper (锁包装器)
│   ├── ReentrantLock (JVM锁)
│   └── EvictionStrategy (锁淘汰策略)
└── DistributedLockSupport (分布式锁层)
    └── RedissonClient (Redis分布式锁)
```

## 二、核心实现分析

### 2.1 锁包装器 (LockWrapper.java)

**文件位置**：`SyncSupport.java:16-19`, `LockWrapper.java:7-20`

**设计目标**：

- 封装 ReentrantLock，提供淘汰能力判断
- 防止正在使用的锁被淘汰导致死锁

**核心实现**：

```java
public class LockWrapper {
    private final ReentrantLock lock;

    // 判断锁是否可淘汰: 未被持有 && 无等待线程
    public boolean canEvict() {
        return !lock.isLocked() && !lock.hasQueuedThreads();
    }
}
```

**关键设计点**：

1. `isLocked()`：检查锁是否被持有
2. `hasQueuedThreads()`：检查是否有线程在等待队列中
3. 只有两个条件都为 `false` 时才允许淘汰

### 2.2 本地锁支持 (InternalLockSupport)

**文件位置**：`SyncSupport.java:216-370`

#### 2.2.1 初始化配置

```java
// 默认配置 (SyncSupport.java:232-233)
maxActiveSize: 1024   // 活跃锁容量
maxInactiveSize: 512  // 非活跃锁容量
```

#### 2.2.2 锁淘汰策略

```java
// 使用双链表淘汰策略 (SyncSupport.java:238-240)
this.lockStrategy = EvictionStrategyFactory.createTwoListWithPredicate(
    maxActiveSize,
    maxInactiveSize,
    LockWrapper::canEvict  // 淘汰判断器
);
```

**淘汰算法**：

- **Active List**：存放最近访问的锁 (67% 容量)
- **Inactive List**：存放不活跃的锁 (33% 容量)
- **淘汰条件**：只淘汰满足 `canEvict()` 的锁

#### 2.2.3 锁获取流程

```java
// SyncSupport.java:287-299
public LockWrapper tryAcquire(String key, long timeoutSeconds)
        throws InterruptedException {

    LockWrapper wrapper = getOrCreateLock(key);  // 获取或创建锁
    ReentrantLock lock = wrapper.getLock();

    boolean acquired = lock.tryLock(timeoutSeconds, TimeUnit.SECONDS);
    if (acquired) {
        return wrapper;  // 获取成功
    }
    return null;  // 超时失败
}
```

#### 2.2.4 锁创建逻辑

```java
// SyncSupport.java:318-329
private LockWrapper getOrCreateLock(String key) {
    LockWrapper wrapper = lockStrategy.get(key);
    if (wrapper != null) {
        return wrapper; // 复用已存在的锁
    }

    // 创建新锁并放入淘汰策略
    LockWrapper newWrapper = new LockWrapper();
    lockStrategy.put(key, newWrapper);
    return newWrapper;
}
```

**关键特性**：

1. **锁对象复用**：相同 key 复用锁对象
2. **自动淘汰**：超出容量时淘汰未使用的锁
3. **线程安全**：淘汰策略内部保证线程安全

### 2.3 分布式锁支持 (DistributedLockSupport)

**文件位置**：`SyncSupport.java:89-214`

#### 2.3.1 锁键设计

```java
// SyncSupport.java:105
private static final String LOCK_PREFIX = "cache:lock:";

// 完整键格式: cache:lock:{cacheKey}
```

#### 2.3.2 锁获取实现

```java
// SyncSupport.java:159-171
public RLock tryAcquire(String key, long timeoutSeconds)
        throws InterruptedException {

    String lockKey = LOCK_PREFIX + key;
    RLock lock = redissonClient.getLock(lockKey);

    // tryLock(等待时间, 租期, 时间单位)
    // leaseTime = -1 启用看门狗自动续期
    boolean acquired = lock.tryLock(timeoutSeconds, -1, TimeUnit.SECONDS);

    return acquired ? lock : null;
}
```

**Redisson 特性应用**：

1. **看门狗机制**：`leaseTime = -1` 启用自动续期
2. **可重入性**：支持同一线程多次获取
3. **集群支持**：支持 Redis 主从/哨兵/集群模式

#### 2.3.3 锁释放逻辑

```java
// SyncSupport.java:179-188
public void release(RLock lock, String key) {
    // 只释放当前线程持有的锁
    if (lock != null && lock.isHeldByCurrentThread()) {
        try {
            lock.unlock();
        } catch (Exception e) {
            log.error("Failed to release distributed lock for key: {}", key, e);
        }
    }
}
```

**安全检查**：

- `isHeldByCurrentThread()`：防止释放其他线程的锁
- **异常捕获**：避免解锁失败导致业务中断

### 2.4 两级锁协调器 (SyncSupport)

**文件位置**：`SyncSupport.java:18-87`

#### 2.4.1 完整执行流程

```java
// SyncSupport.java:40-86
public <T> T executeSync(String key, Supplier<T> loader, long timeoutSeconds) {
    LockWrapper internalLock = null;
    RLock distributedLock = null;

    try {
        // 第一级: 获取本地锁
        internalLock = internalLockSupport.tryAcquire(key, timeoutSeconds);
        if (internalLock == null) {
            log.warn("Failed to acquire internal lock");
            return loader.get();  // 降级: 直接执行
        }

        // 第二级: 获取分布式锁
        distributedLock = distributedLockSupport.tryAcquire(key, timeoutSeconds);
        if (distributedLock == null) {
            log.warn("Failed to acquire distributed lock");
            return loader.get();  // 降级: 直接执行
        }

        // 双锁持有, 执行数据加载
        return loader.get();

    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        return loader.get();  // 降级处理

    } finally {
        // 先释放外层锁(分布式锁)
        if (distributedLock != null) {
            distributedLockSupport.release(distributedLock, key);
        }
        // 再释放内层锁(本地锁)
        if (internalLock != null) {
            internalLockSupport.release(internalLock, key);
        }
    }
}
```

#### 2.4.2 关键设计原则

1. **锁获取顺序**：
    - 本地锁 → 分布式锁
    - **原因**：本地锁开销小，先过滤同 JVM 内的并发

2. **锁释放顺序**：
    - 分布式锁 → 本地锁
    - **原因**：先释放外层锁，避免其他节点无法获取

3. **降级策略**：
    - 锁获取失败 → 不阻塞请求，直接执行 loader
    - 中断异常 → 恢复中断状态，执行 loader
    - **目的**：保证可用性，避免因锁故障导致服务不可用

## 三、业务集成点

### 3.1 缓存读取集成 (RedisProCacheWriter.java)

#### 3.1.1 同步模式判断

```java
// RedisProCacheWriter.java:93-104
public byte[] get(String name, byte[] key, Duration ttl) {
    String redisKey = writerChainableUtils.TypeSupport().bytesToString(key);
    String actualKey = extractActualKey(name, redisKey);

    // 检查是否启用 sync 模式
    RedisCacheableOperation cacheOperation =
        redisCacheRegister.getCacheableOperation(name, actualKey);

    if (cacheOperation != null && cacheOperation.isSync()) {
        return getWithSync(name, redisKey, actualKey, ttl, cacheOperation);
    }

    return getNormal(name, redisKey, actualKey, ttl, cacheOperation);
}
```

#### 3.1.2 同步读取实现

```java
// RedisProCacheWriter.java:107-120
private byte[] getWithSync(...) {
    return writerChainableUtils
        .SyncSupport()
        .executeSync(
            redisKey,
            () -> getNormal(...), // 缓存未命中时的加载逻辑
            10 // 锁等待超时 10 秒
        );
}
```

### 3.2 条件写入集成 (putIfAbsent)

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

## 四、测试验证

### 4.1 缓存击穿防护测试 (SyncCacheTest.java)

**文件位置**：`SyncCacheTest.java:54-89`

#### 4.1.1 测试场景

```java
@Test
@DisplayName("sync=true 应该防止缓存击穿")
public void testSyncPreventsCachePenetration() throws InterruptedException {
    int threadCount = 10;
    CountDownLatch startLatch = new CountDownLatch(1);

    // 10 个线程同时请求同一个不存在的缓存
    for (int i = 0; i < threadCount; i++) {
        executor.submit(() -> {
            startLatch.await();
            String result = syncCacheService.getUserName(1L);
            assertThat(result).isEqualTo("David-1");
        });
    }

    startLatch.countDown();  // 同时启动所有线程
    endLatch.await(10, TimeUnit.SECONDS);

    // 验证: 方法只被调用 1 次
    assertThat(syncCacheService.getCallCount()).isEqualTo(1);
}
```

**测试结果**：

- ✅ 10 个并发请求
- ✅ 实际方法只调用 1 次
- ✅ 其他 9 个线程等待第一个线程加载完成

### 4.2 缓存命中测试

**文件位置**：`SyncCacheTest.java:91-123`

```java
@Test
@DisplayName("sync=true 缓存命中时不会加锁")
public void testSyncDoesNotLockOnCacheHit() throws InterruptedException {
    // 先预热缓存
    syncCacheService.getUserName(2L);

    // 20 个线程并发读取
    syncCacheService.resetCallCount();
    for (int i = 0; i < 20; i++) {
        executor.submit(() -> syncCacheService.getUserName(2L));
    }

    // 验证: 方法调用次数为 0 (都命中缓存)
    assertThat(syncCacheService.getCallCount()).isEqualTo(0);
}
```

**测试结果**：

- ✅ 缓存命中时不加锁
- ✅ 20 个并发请求全部直接返回
- ✅ 不执行实际业务方法

## 五、性能优化设计

### 5.1 本地锁池化机制

**优化点**：

1. **锁对象复用**：相同 key 复用 LockWrapper 对象
2. **自动淘汰**：使用双链表 LRU 算法淘汰冷锁
3. **智能淘汰**：只淘汰未被持有的锁

**内存占用估算**：

- 默认配置：1024(Active) + 512(Inactive) = 1536 个锁
- 每个 ReentrantLock 约 48 字节
- 总内存：1536 × 48 = ~74 KB

### 5.2 分布式锁优化

**看门狗机制**：

```java
// leaseTime = -1 启用看门狗
lock.tryLock(timeoutSeconds, -1, TimeUnit.SECONDS);
```

**优势**：

- **自动续期**：防止业务执行时间过长导致锁过期
- **避免死锁**：客户端宕机时自动释放（默认 30 秒）

### 5.3 降级策略

**设计哲学**：可用性优先于一致性

**降级场景**：

1. 本地锁获取超时 → 直接执行
2. 分布式锁获取超时 → 直接执行
3. 线程中断 → 恢复中断状态，直接执行

**影响分析**：

- **最坏情况**：多个节点同时加载相同数据
- **业务影响**：数据库压力增加，但服务不中断
- **适用场景**：读多写少的缓存场景

## 六、日志设计

### 6.1 日志级别策略

**DEBUG 级别**（开发/排查问题）：

```java
log.debug("Acquired internal lock for key: {}", key);
log.debug("Acquired distributed lock for key: {}", key);
log.debug("Released internal lock for key: {}", key);
```

**WARN 级别**（潜在问题）：

```java
log.warn("Failed to acquire internal lock within {} seconds: {}", timeout, key);
log.warn("Failed to acquire distributed lock within {} seconds: {}", timeout, key);
```

**ERROR 级别**（异常情况）：

```java
log.error("Interrupted while waiting for lock on key: {}", key, e);
log.error("Failed to release lock for key: {}", key, e);
```

### 6.2 日志封装

**示例**：

```java
// SyncSupport.java:190-213
private void logAcquired(String key) {
    log.debug("Acquired distributed lock for key: {}", key);
}

private void logReleaseFailure(String key, Exception e) {
    log.error("Failed to release distributed lock for key: {}", key, e);
}
```

**好处**：

1. 日志格式统一
2. 易于修改日志内容
3. 符合 DRY 原则

## 七、最佳实践总结

### 7.1 适用场景

✅ **推荐使用**：

- 缓存失效时间集中
- 数据加载耗时较长 (>100ms)
- 数据库查询开销大
- 多实例部署环境

❌ **不推荐使用**：

- 缓存命中率极高 (>99%)
- 数据加载极快 (<10ms)
- 单实例部署
- 对一致性要求不高的场景

### 7.2 配置建议

**本地锁池容量**：

```java
// 根据缓存 key 数量调整
maxActiveSize = 缓存 key 数量 × 0.1  // 取 10%
maxInactiveSize = maxActiveSize / 2
```

**锁超时时间**：

```java
// 根据业务加载时间调整
timeout = 业务最大加载时间 × 2  // 留 100% 余量
建议范围: 5-30 秒
```

### 7.3 监控指标

**关键指标**：

1. **锁获取失败率**：`lock_acquire_failure_rate`
2. **锁等待时间**：`lock_wait_duration`
3. **锁池命中率**：`lock_pool_hit_rate`
4. **锁池淘汰次数**：`lock_eviction_count`

## 八、潜在风险与改进

### 8.1 已知风险

1. **降级策略可能导致缓存击穿**
    - **场景**：分布式锁全部获取失败
    - **影响**：大量请求直达数据库
    - **建议**：增加重试机制或熔断器

2. **本地锁淘汰可能导致并发**
    - **场景**：锁被淘汰后重新创建
    - **影响**：短暂的并发窗口期
    - **建议**：增大锁池容量

### 8.2 改进建议

1. **增加锁等待队列监控**：

    ```java
    public int getWaitingThreads(String key) {
        LockWrapper wrapper = lockStrategy.get(key);
        return wrapper != null ? wrapper.getLock().getQueueLength() : 0;
    }
    ```

2. **支持自定义超时策略**：

    ```java
    @RedisCacheable(
        sync = true,
        syncTimeout = 5,        // 本地锁超时
        distributedTimeout = 10 // 分布式锁超时
    )
    ```

3. **增加锁竞争降级策略**：

    ```java
    // 当锁竞争激烈时，自动降级为布隆过滤器
    if (lockCompetitionRate > threshold) {
        useBloomFilter();
    }
    ```

## 九、代码质量评估

### 9.1 符合规范

✅ **异常处理**：

- 捕获 `InterruptedException` 后恢复中断状态
- 使用日志记录异常，不影响业务流程

✅ **日志规约**：

- 使用 SLF4J + Lombok `@Slf4j`
- DEBUG 级别使用占位符：`log.debug("{}", key)`
- 避免字符串拼接

✅ **DRY 原则**：

- 日志方法封装
- 锁获取/释放逻辑复用

### 9.2 改进空间

1. **NPE 防护**：

    ```java
    // 建议增加 @NonNull 注解
    public <T> T executeSync(@NonNull String key,
                            @NonNull Supplier<T> loader,
                            long timeoutSeconds)
    ```

2. **资源释放**：

    ```java
    // finally 中已正确释放，符合规范
    finally {
        if (distributedLock != null) {
            distributedLockSupport.release(distributedLock, key);
        }
        if (internalLock != null) {
            internalLockSupport.release(internalLock, key);
        }
    }
    ```

## 十、总结

CacheGuard 的锁机制设计体现了以下核心思想：

1. **分层设计**：本地锁 + 分布式锁，逐层过滤并发
2. **降级优先**：锁故障时保证服务可用性
3. **资源优化**：锁池化 + 自动淘汰，控制内存占用
4. **可观测性**：完善的日志体系，便于问题排查

**核心价值**：

- 有效防止缓存击穿
- 降低数据库压力
- 支持多实例部署
- 保证服务高可用

**适用场景**：读多写少、数据加载耗时、多实例部署的分布式缓存系统
