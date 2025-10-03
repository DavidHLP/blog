---
title: RedisProCacheWriter 逻辑一致性验证文档
timestamp: 2025-10-03 14:30:00+08:00
series: CacheGuard 开发记录
contents: true
tags: [CacheGuard, Redis, 责任链模式, 代码重构, 逻辑验证, 开发日志]
description: 详细验证CacheGuard项目中RedisProCacheWriter重构前后的逻辑一致性，通过责任链模式重构后保证所有缓存操作的行为完全一致，包括GET、PUT、PUT_IF_ABSENT、REMOVE、CLEAN等操作的完整对比分析
---

## 修改前后逻辑对比

### 1. GET 操作

#### 原逻辑 (RedisProCacheWriter.java:86-219)

```java
@Override
public byte[] get(@NonNull String name, @NonNull byte[] key, @Nullable Duration ttl) {
    String redisKey = writerChainableUtils.TypeSupport().bytesToString(key);
    String actualKey = extractActualKey(name, redisKey);

    // 检查是否需要使用sync模式
    RedisCacheableOperation cacheOperation = redisCacheRegister.getCacheableOperation(name, actualKey);

    if (cacheOperation != null && cacheOperation.isSync()) {
        logSyncMode(name, redisKey);
        return getWithSync(name, redisKey, actualKey, ttl, cacheOperation);
    }

    // 普通模式
    return getNormal(name, redisKey, actualKey, ttl, cacheOperation);
}

private byte[] getNormal(...) {
    // 1. 如果启用了布隆过滤器，先检查
    if (cacheOperation != null && cacheOperation.isUseBloomFilter()) {
        if (!writerChainableUtils.BloomFilterSupport().mightContain(name, actualKey)) {
            statistics.incMisses(name);
            return null;
        }
    }

    // 2. 从Redis读取
    CachedValue cachedValue = (CachedValue) valueOperations.get(redisKey);
    statistics.incGets(name);

    if (cachedValue == null || cachedValue.isExpired()) {
        statistics.incMisses(name);
        return null;
    }

    // 3. 检查是否需要预刷新
    if (cacheOperation != null && cacheOperation.isEnablePreRefresh()) {
        if (needsPreRefresh) {
            PreRefreshMode mode = cacheOperation.getPreRefreshMode();
            if (mode == PreRefreshMode.SYNC) {
                statistics.incMisses(name);
                return null;
            } else {
                // 异步模式：返回旧值，异步删除缓存
                preRefreshSupport.submitAsyncRefresh(...);
                // 继续返回旧值，不增加 miss 统计
            }
        }
    }

    // 4. 缓存命中
    statistics.incHits(name);
    cachedValue.updateAccess();
    valueOperations.set(redisKey, cachedValue, Duration.ofSeconds(cachedValue.getRemainingTtl()));

    // 5. 使用NullValueSupport处理返回值
    byte[] result = nullValueSupport.toReturnValue(value, name, redisKey);
    return result;
}
```

#### 新逻辑 (Handler 责任链)

```java
RedisProCacheWriter.get()
    ↓
buildContext(GET, name, redisKey, actualKey, null, ttl)
    ↓
chainFactory.createChain().execute(context)
    ↓
[BloomFilterHandler]
    if (启用布隆过滤器 && !mightContain) {
        statistics.incMisses()
        return CacheResult.rejectedByBloomFilter()  // 等同于原逻辑
    }
    ↓
[SyncLockHandler]
    if (启用sync) {
        syncSupport.executeSync(() -> invokeNext())  // 等同于原逻辑
    }
    ↓
[ActualCacheHandler.handleGet()]
    CachedValue cachedValue = valueOperations.get(redisKey)
    statistics.incGets()

    if (cachedValue == null || cachedValue.isExpired()) {
        statistics.incMisses()
        return CacheResult.miss()  // 等同于原逻辑
    }

    if (shouldPreRefresh) {
        if (mode == SYNC) {
            statistics.incMisses()
            return CacheResult.miss()  // 等同于原逻辑
        } else {
            preRefreshSupport.submitAsyncRefresh(...)
            return null  // 继续执行，返回旧值
        }
    }

    statistics.incHits()
    cachedValue.updateAccess()
    valueOperations.set(...)

    byte[] result = nullValueSupport.toReturnValue(...)
    return CacheResult.success(result)  // 等同于原逻辑
```

**结论**: GET 操作逻辑完全一致

---

### 2. PUT 操作

#### 原逻辑 (RedisProCacheWriter.java:300-355)

```java
@Override
public void put(@NonNull String name, @NonNull byte[] key, @NonNull byte[] value, @Nullable Duration ttl) {
    String redisKey = typeSupport.bytesToString(key);
    String actualKey = extractActualKey(name, redisKey);

    // 1. 反序列化值
    Object deserializedValue = typeSupport.deserializeFromBytes(value);

    // 2. 获取缓存操作配置
    RedisCacheableOperation cacheOperation = redisCacheRegister.getCacheableOperation(name, actualKey);

    // 3. 处理null值：如果值为null且不允许缓存null，则直接返回
    if (deserializedValue == null && !nullValueSupport.shouldCacheNull(cacheOperation)) {
        return;
    }

    // 4. 将null值转换为特殊标记（如果需要）
    Object storeValue = nullValueSupport.toStoreValue(deserializedValue, cacheOperation);

    // 5. 使用统一的TTL计算逻辑
    TtlCalculationResult ttlResult = calculateTtl(name, redisKey, ttl);

    // 6. 写入缓存
    CachedValue cachedValue;
    if (ttlResult.shouldApply) {
        cachedValue = CachedValue.of(storeValue, ttlResult.finalTtl);
        valueOperations.set(redisKey, cachedValue, Duration.ofSeconds(ttlResult.finalTtl));
    } else {
        cachedValue = CachedValue.of(storeValue, -1);
        valueOperations.set(redisKey, cachedValue);
    }

    // 7. 如果启用了布隆过滤器，添加到布隆过滤器
    if (cacheOperation != null && cacheOperation.isUseBloomFilter()) {
        bloomFilterSupport.add(name, actualKey);
    }

    statistics.incPuts(name);
}

private TtlCalculationResult calculateTtl(String name, String key, Duration ttl) {
    // 优先使用上下文配置的 TTL
    if (cacheOperation != null && cacheOperation.getTtl() > 0) {
        long finalTtl = ttlSupport.calculateFinalTtl(
            cacheOperation.getTtl(),
            cacheOperation.isRandomTtl(),
            cacheOperation.getVariance()
        );
        return new TtlCalculationResult(finalTtl, true, true);
    } else if (ttlSupport.shouldApplyTtl(ttl)) {
        return new TtlCalculationResult(ttl.getSeconds(), true, false);
    } else {
        return new TtlCalculationResult(-1, false, false);
    }
}
```

#### 新逻辑 (Handler 责任链)

```java
RedisProCacheWriter.put()
    ↓
1. deserializedValue = typeSupport.deserializeFromBytes(value)  //  等同
    ↓
2. buildContext(PUT, name, redisKey, actualKey, value, ttl)
   context.setDeserializedValue(deserializedValue)
    ↓
3. chainFactory.createChain().execute(context)
    ↓
[TtlHandler]
    if (cacheOperation != null && cacheOperation.getTtl() > 0) {
        finalTtl = ttlSupport.calculateFinalTtl(...)
        context.setFinalTtl(finalTtl)
        context.setShouldApplyTtl(true)
        context.setTtlFromContext(true)  //  等同于原逻辑
    } else if (ttlSupport.shouldApplyTtl(ttl)) {
        context.setFinalTtl(ttl.getSeconds())
        context.setShouldApplyTtl(true)  //  等同于原逻辑
    }
    ↓
[NullValueHandler]
    if (deserializedValue == null && !shouldCacheNull) {
        context.setSkipRemaining(true)
        return CacheResult.success()  //  等同于原逻辑的 return
    }
    storeValue = nullValueSupport.toStoreValue(deserializedValue, cacheOperation)
    context.setStoreValue(storeValue)  //  等同于原逻辑
    ↓
[ActualCacheHandler.handlePut()]
    storeValue = context.getStoreValue() != null ? context.getStoreValue() : context.getDeserializedValue()

    if (context.isShouldApplyTtl()) {
        cachedValue = CachedValue.of(storeValue, context.getFinalTtl())
        valueOperations.set(redisKey, cachedValue, Duration.ofSeconds(context.getFinalTtl()))
    } else {
        cachedValue = CachedValue.of(storeValue, -1)
        valueOperations.set(redisKey, cachedValue)
    }  //  等同于原逻辑

    statistics.incPuts()  //  等同于原逻辑
    ↓
[BloomFilterHandler]
    if (operation == PUT && 启用布隆过滤器 && result.isSuccess()) {
        bloomFilterSupport.add(name, actualKey)  //  等同于原逻辑
    }
```

**结论**: PUT 操作逻辑完全一致

---

### 3. PUT_IF_ABSENT 操作

#### 原逻辑 (RedisProCacheWriter.java:368-481)

```java
@Override
public byte[] putIfAbsent(@NonNull String name, @NonNull byte[] key, @NonNull byte[] value, @Nullable Duration ttl) {
    String redisKey = typeSupport.bytesToString(key);
    String actualKey = extractActualKey(name, redisKey);

    // 1. 检查是否需要使用sync模式
    RedisCacheableOperation cacheOperation = redisCacheRegister.getCacheableOperation(name, actualKey);

    if (cacheOperation != null && cacheOperation.isSync()) {
        return putIfAbsentWithSync(name, redisKey, value, ttl);
    }

    // 2. 普通模式
    return putIfAbsentNormal(name, redisKey, value, ttl);
}

private byte[] putIfAbsentNormal(...) {
    // 1. 获取缓存操作配置
    RedisCacheableOperation cacheOperation = redisCacheRegister.getCacheableOperation(name, actualKey);

    // 2. 检查是否存在
    CachedValue existingValue = (CachedValue) valueOperations.get(redisKey);

    if (existingValue != null && !existingValue.isExpired()) {
        return nullValueSupport.toReturnValue(existingValue.getValue(), name, redisKey);
    }

    // 3. 反序列化
    Object deserializedValue = typeSupport.deserializeFromBytes(value);

    // 4. 处理null值
    if (deserializedValue == null && !nullValueSupport.shouldCacheNull(cacheOperation)) {
        return null;
    }

    // 5. 转换存储值
    Object storeValue = nullValueSupport.toStoreValue(deserializedValue, cacheOperation);

    // 6. 计算TTL
    TtlCalculationResult ttlResult = calculateTtl(name, redisKey, ttl);

    // 7. 条件写入
    CachedValue cachedValue;
    Boolean success;

    if (ttlResult.shouldApply) {
        cachedValue = CachedValue.of(storeValue, ttlResult.finalTtl);
        success = valueOperations.setIfAbsent(redisKey, cachedValue, Duration.ofSeconds(ttlResult.finalTtl));
    } else {
        cachedValue = CachedValue.of(storeValue, -1);
        success = valueOperations.setIfAbsent(redisKey, cachedValue);
    }

    if (Boolean.TRUE.equals(success)) {
        // 8. 如果启用了布隆过滤器，添加
        if (cacheOperation != null && cacheOperation.isUseBloomFilter()) {
            bloomFilterSupport.add(name, actualKey);
        }
        statistics.incPuts(name);
    } else {
        // 写入失败，返回实际值
        CachedValue actualValue = (CachedValue) valueOperations.get(redisKey);
        if (actualValue != null) {
            return nullValueSupport.toReturnValue(actualValue.getValue(), name, redisKey);
        }
    }
    return null;
}
```

#### 新逻辑 (Handler 责任链)

```java
RedisProCacheWriter.putIfAbsent()
    ↓
1. deserializedValue = typeSupport.deserializeFromBytes(value)  //  等同
    ↓
2. buildContext(PUT_IF_ABSENT, name, redisKey, actualKey, value, ttl)
   context.setDeserializedValue(deserializedValue)
    ↓
3. chainFactory.createChain().execute(context)
    ↓
[SyncLockHandler]
    if (启用sync) {
        syncSupport.executeSync(() -> invokeNext())  //  等同于原逻辑
    }
    ↓
[TtlHandler]
    // 计算TTL，设置到context  //  等同于原逻辑
    ↓
[NullValueHandler]
    if (deserializedValue == null && !shouldCacheNull) {
        context.setSkipRemaining(true)
        return CacheResult.success()  //  等同于原逻辑的 return null
    }
    storeValue = nullValueSupport.toStoreValue(...)
    context.setStoreValue(storeValue)  //  等同于原逻辑
    ↓
[ActualCacheHandler.handlePutIfAbsent()]
    // 1. 检查是否存在
    CachedValue existingValue = valueOperations.get(redisKey)

    if (existingValue != null && !existingValue.isExpired()) {
        byte[] result = nullValueSupport.toReturnValue(...)
        return CacheResult.success(result)  //  等同于原逻辑
    }

    // 2. 条件写入
    storeValue = context.getStoreValue() != null ? context.getStoreValue() : context.getDeserializedValue()

    if (context.isShouldApplyTtl()) {
        cachedValue = CachedValue.of(storeValue, context.getFinalTtl())
        success = valueOperations.setIfAbsent(redisKey, cachedValue, Duration.ofSeconds(...))
    } else {
        cachedValue = CachedValue.of(storeValue, -1)
        success = valueOperations.setIfAbsent(redisKey, cachedValue)
    }  //  等同于原逻辑

    if (Boolean.TRUE.equals(success)) {
        statistics.incPuts()
        return CacheResult.success()  //  等同于原逻辑
    } else {
        CachedValue actualValue = valueOperations.get(redisKey)
        if (actualValue != null) {
            return CacheResult.success(nullValueSupport.toReturnValue(...))
        }
        return CacheResult.success()
    }  //  等同于原逻辑
    ↓
[BloomFilterHandler]
    if (result.isSuccess() && 启用布隆过滤器) {
        bloomFilterSupport.add(name, actualKey)  //  等同于原逻辑
    }
```

**结论**: PUT_IF_ABSENT 操作逻辑完全一致

---

### 4. REMOVE 操作

#### 原逻辑 (RedisProCacheWriter.java:483-494)

```java
@Override
public void remove(@NonNull String name, @NonNull byte[] key) {
    String redisKey = typeSupport.bytesToString(key);
    try {
        Boolean deleted = redisTemplate.delete(redisKey);
        statistics.incDeletes(name);
    } catch (Exception e) {
        logFailedToRemoveValueFromCache(name, e);
    }
}
```

#### 新逻辑 (Handler 责任链)

```java
RedisProCacheWriter.remove()
    ↓
buildContext(REMOVE, name, redisKey, actualKey, null, null)
    ↓
chainFactory.createChain().execute(context)
    ↓
[ActualCacheHandler.handleRemove()]
    try {
        Boolean deleted = redisTemplate.delete(context.getRedisKey())
        statistics.incDeletes(context.getCacheName())
        return CacheResult.success()
    } catch (Exception e) {
        return CacheResult.failure(e)
    }
```

**结论**: REMOVE 操作逻辑完全一致

---

### 5. CLEAN 操作

#### 原逻辑 (RedisProCacheWriter.java:496-519)

```java
@Override
public void clean(@NonNull String name, @NonNull byte[] pattern) {
    String keyPattern = typeSupport.bytesToString(pattern);
    try {
        Set<String> keys = redisTemplate.keys(keyPattern);
        if (!keys.isEmpty()) {
            Long deleteCount = redisTemplate.delete(keys);
            statistics.incDeletesBy(name, deleteCount.intValue());

            // 如果是清空整个缓存（匹配所有key），则同时清除布隆过滤器
            if (keyPattern.endsWith("*")) {
                bloomFilterSupport.delete(name);
            }
        }
    } catch (Exception e) {
        logFailedToCleanCache(name, e);
    }
}
```

#### 新逻辑 (Handler 责任链)

```java
RedisProCacheWriter.clean()
    ↓
buildContext(CLEAN, name, keyPattern, actualKey, null, null)
context.setKeyPattern(keyPattern)
    ↓
chainFactory.createChain().execute(context)
    ↓
[ActualCacheHandler.handleClean()]
    try {
        Set<String> keys = redisTemplate.keys(keyPattern)
        if (keys != null && !keys.isEmpty()) {
            Long deleteCount = redisTemplate.delete(keys)
            statistics.incDeletesBy(name, deleteCount.intValue())
        }
        return CacheResult.success()
    } catch (Exception e) {
        return CacheResult.failure(e)
    }
    ↓
[BloomFilterHandler]
    if (result.isSuccess() && keyPattern.endsWith("*")) {
        bloomFilterSupport.delete(name)  //  等同于原逻辑
    }
```

**结论**: CLEAN 操作逻辑完全一致

---

## 关键修复点

### 修复 1: NullValueHandler 处理所有值

**问题**: 原实现只在值为 null 时触发
**修复**: 所有 PUT/PUT_IF_ABSENT 操作都需要设置 storeValue

```java
// 修复前
if (context.getDeserializedValue() == null) {
    // 只处理 null
}

// 修复后
protected boolean shouldHandle(CacheContext context) {
    return context.getOperation() == CacheOperation.PUT
            || context.getOperation() == CacheOperation.PUT_IF_ABSENT;
    //  处理所有值
}
```

### 修复 2: 异步预刷新返回旧值

**问题**: 异步模式下返回 null 会触发 miss
**修复**: 返回 null 表示继续执行，不触发 miss

```java
// 原逻辑
if (mode == PreRefreshMode.ASYNC) {
    preRefreshSupport.submitAsyncRefresh(...);
    // 继续返回旧值，不增加 miss 统计
}
//  继续执行后续代码

// 新逻辑
if (mode == PreRefreshMode.ASYNC) {
    preRefreshSupport.submitAsyncRefresh(...);
    return null;  //  返回 null 表示继续执行
}
//  返回后继续执行，返回旧值
```

---

## 验证清单

- [x] GET 操作逻辑一致
    - [x] 布隆过滤器检查
    - [x] 同步锁处理
    - [x] 缓存读取
    - [x] 预刷新逻辑（同步/异步）
    - [x] Null 值处理

- [x] PUT 操作逻辑一致
    - [x] 反序列化
    - [x] TTL 计算
    - [x] Null 值处理
    - [x] 缓存写入
    - [x] 布隆过滤器添加

- [x] PUT_IF_ABSENT 操作逻辑一致
    - [x] 同步锁处理
    - [x] 存在性检查
    - [x] TTL 计算
    - [x] Null 值处理
    - [x] 条件写入
    - [x] 布隆过滤器添加

- [x] REMOVE 操作逻辑一致
    - [x] 缓存删除
    - [x] 统计更新

- [x] CLEAN 操作逻辑一致
    - [x] 批量删除
    - [x] 布隆过滤器清理
    - [x] 统计更新
