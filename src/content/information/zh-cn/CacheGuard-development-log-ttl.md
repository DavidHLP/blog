# CacheGuard TTL功能开发日志

## 一、功能概述

本次开发实现了CacheGuard的核心TTL（Time To Live）管理功能，包括：

- 自定义TTL配置
- TTL随机化（雪崩防护）
- 统一的TTL计算逻辑

## 二、核心实现

### 2.1 TTL支持工具类 (TtlSupport)

**文件位置**: `src/main/java/com/david/spring/cache/redis/core/writer/support/TtlSupport.java`

**核心功能**:

1. **TTL有效性判断**
```java
public boolean shouldApplyTtl(Duration ttl)
```
判断TTL是否应该被应用（非null、非零、非负）

2. **TTL随机化计算**
```java
public long calculateFinalTtl(Long baseTtl, boolean randomTtl, float variance)
```
- 使用高斯分布生成随机因子
- 限制随机因子在[-3, 3]范围内，确保99.7%的数据落在合理范围
- 基于方差（variance）调整随机化程度
- 确保最终TTL在[1, baseTtl*2]范围内

3. **辅助方法**
- `isExpired()`: 检查缓存是否过期
- `getRemainingTtl()`: 获取剩余TTL
- `fromDuration()` / `toDuration()`: Duration与秒数的转换

### 2.2 缓存写入器 (RedisProCacheWriter)

**文件位置**: `src/main/java/com/david/spring/cache/redis/core/writer/RedisProCacheWriter.java`

**核心功能**:

1. **统一的TTL计算逻辑**
```java
private TtlCalculationResult calculateTtl(String name, String key, @Nullable Duration ttl)
```
**优先级**:
- 上下文配置的TTL（来自`@RedisCacheable`注解）
- 方法参数传入的TTL
- 默认TTL（60秒）

2. **缓存写入 (put)**
- 反序列化数据
- 计算最终TTL（支持随机化）
- 存储到Redis并设置过期时间
- 记录详细的调试日志

3. **条件写入 (putIfAbsent)**
- 检查缓存是否已存在
- 仅在不存在时写入
- 支持TTL配置

4. **测试辅助方法**
```java
protected long getTtl(String redisKey)        // 获取缓存值中存储的TTL
protected long getExpiration(String redisKey) // 获取Redis中的实际过期时间
```

### 2.3 缓存值封装 (CachedValue)

**文件位置**: `src/main/java/com/david/spring/cache/redis/core/writer/CachedValue.java`

**字段说明**:
- `value`: 缓存的实际值
- `type`: 值的类型
- `ttl`: 生存时间（秒）
- `createdTime`: 创建时间戳

**核心方法**:
- `isExpired()`: 判断是否过期
- `getRemainingTtl()`: 获取剩余TTL

### 2.4 工具类链式调用 (WriterChainableUtils)

**文件位置**: `src/main/java/com/david/spring/cache/redis/core/writer/WriterChainableUtils.java`

提供TtlSupport的访问接口，支持链式调用。

## 三、测试实现

### 3.1 集成测试 (BasicCacheTest)

**文件位置**: `src/test/java/com/david/spring/cache/redis/service/BasicCacheTest.java`

**测试用例**:

1. **testCustomTtl() - 自定义TTL功能测试**
   - 验证缓存写入和读取
   - 验证TTL设置为300秒
   - 验证缓存命中后不再执行方法
   - 验证TTL随时间递减

2. **testRandomTtlForAvalanchePrevention() - 雪崩防护测试**
   - 创建多个缓存条目
   - 验证TTL在合理范围内（150-600秒）
   - 验证TTL确实发生了随机化

### 3.2 单元测试 (RedisProCacheWriterTest)

**文件位置**: `src/test/java/com/david/spring/cache/redis/core/writer/RedisProCacheWriterTest.java`

**测试覆盖**:
- 使用自定义TTL存储
- 使用默认TTL存储
- 条件存储（缓存不存在）
- 条件存储（缓存已存在）

**测试框架**:
- JUnit 5
- Mockito（用于依赖模拟）
- AssertJ（用于断言）

### 3.3 测试配置

**文件位置**: `src/test/java/com/david/spring/cache/redis/config/TestConfig.java`

提供测试专用的`RedisProCacheWriterTestable` Bean，暴露了受保护的方法用于测试。

## 四、技术亮点

### 4.1 雪崩防护机制

**问题**: 大量缓存同时过期导致数据库压力骤增

**解决方案**:
- 使用高斯分布生成随机因子
- 根据配置的方差（variance）调整随机化程度
- 确保TTL在合理范围内波动

**示例**:
```java
@RedisCacheable(value = "user", key = "#id", ttl = 300, randomTtl = true, variance = 0.5F)
```
生成的TTL范围: [150, 600]秒

### 4.2 TTL优先级设计

采用明确的优先级策略:
1. 注解中配置的TTL（上下文）
2. 方法参数传入的TTL
3. 默认TTL（60秒）

这种设计确保了灵活性和一致性。

### 4.3 完善的日志记录

每个关键操作都有详细的DEBUG日志:
- TTL计算过程
- 数据序列化/反序列化
- 缓存存储结果

便于问题排查和性能分析。

## 五、代码质量

### 5.1 异常处理

遵循编码规范:
- 不使用异常做流程控制
- 区分稳定代码和非稳定代码
- 捕获具体的异常类型（JsonProcessingException）
- 记录详细的错误日志

### 5.2 日志规范

- 使用SLF4J + Lombok的@Slf4j
- 使用占位符避免不必要的字符串拼接
- 合理的日志级别（DEBUG/INFO/ERROR）

### 5.3 代码可测试性

- 关键方法标记为protected，便于测试
- 使用依赖注入，便于Mock
- 提供测试专用的配置类

## 六、使用示例

### 6.1 基础用法

```java
@Service
public class UserService {
    @RedisCacheable(value = "user", key = "#id", ttl = 300)
    public User getUser(Long id) {
        return userRepository.findById(id);
    }
}
```

### 6.2 启用雪崩防护

```java
@RedisCacheable(
    value = "user",
    key = "#id",
    ttl = 300,
    randomTtl = true,
    variance = 0.5F
)
public User getUser(Long id) {
    return userRepository.findById(id);
}
```

## 七、总结

本次TTL功能开发完成了：
- [x] 核心TTL管理功能
- [x] 雪崩防护机制
- [x] 完善的单元测试和集成测试
- [x] 详细的日志记录
- [x] 符合编码规范的代码实现

代码质量良好，测试覆盖完整，为后续功能开发奠定了坚实基础。