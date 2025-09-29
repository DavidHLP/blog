---
title: Spring Cache CacheOperationSource Source Code Analysis
timestamp: 2025-09-29 10:57:00+08:00
series: Spring Cache
contents: true
tags: [Spring, Cache, Source Code Analysis]
description: Deep dive into the core source code of Spring Cache module focusing on annotation processing
---

## Overview

This document provides an in-depth analysis of the core source code in the Spring Cache module related to annotation processing, focusing on four key interfaces and classes: `CacheOperationSource`, `AbstractFallbackCacheOperationSource`, `AnnotationCacheOperationSource`, and `CacheAnnotationParser`. These components form the core infrastructure for Spring Cache annotation processing, and understanding their design and collaboration relationships is crucial for mastering how Spring Cache works.

## Component Overview

### Overall Architecture

```
CacheInterceptor (AOP Interceptor)
        ↓
CacheOperationSource (Interface: defines cache operation retrieval contract)
        ↓
AbstractFallbackCacheOperationSource (Abstract class: provides caching and fallback strategy)
        ↓
AnnotationCacheOperationSource (Implementation class: annotation-based cache operation parsing)
        ↓
CacheAnnotationParser (Strategy interface: specific annotation parsing strategy)
        ↓
SpringCacheAnnotationParser (Implementation class: Spring standard annotation parser)
```

### Component Relationship Diagram

```
┌─────────────────────────────────────────────────────┐
│                CacheInterceptor                     │
│                 (AOP Interceptor)                   │
└─────────────────────┬───────────────────────────────┘
                    │ calls getCacheOperations()
                    ↓
┌─────────────────────────────────────────────────────┐
│              CacheOperationSource                   │
│                   (Top-level interface)             │
│  + getCacheOperations(Method, Class): Collection    │
│  + isCandidateClass(Class): boolean                 │
└─────────────────────┬───────────────────────────────┘
                    │ inherits
                    ↓
┌─────────────────────────────────────────────────────┐
│        AbstractFallbackCacheOperationSource         │
│                  (Abstract skeleton implementation)  │
│  - operationCache: Map<Object, Collection>          │
│  # findCacheOperations(Method): Collection          │
│  # findCacheOperations(Class): Collection           │
│  + getCacheOperations(): template method impl.     │
└─────────────────────┬───────────────────────────────┘
                    │ inherits
                    ↓
┌─────────────────────────────────────────────────────┐
│           AnnotationCacheOperationSource            │
│              (Standard annotation parsing impl.)    │
│  - annotationParsers: Set<CacheAnnotationParser>   │
│  + findCacheOperations(): delegates to parser set  │
└─────────────────────┬───────────────────────────────┘
                    │ composition
                    ↓
┌─────────────────────────────────────────────────────┐
│             CacheAnnotationParser                   │
│                 (Strategy interface)                │
│  + parseCacheAnnotations(Method): Collection        │
│  + parseCacheAnnotations(Class): Collection         │
│  + isCandidateClass(Class): boolean                 │
└─────────────────────┬───────────────────────────────┘
                    │ implements
                    ↓
┌─────────────────────────────────────────────────────┐
│          SpringCacheAnnotationParser                │
│            (Spring standard annotation parser)      │
│  Parses @Cacheable, @CacheEvict, @CachePut         │
└─────────────────────────────────────────────────────┘
```

## Detailed Component Analysis

### 1. CacheOperationSource - Top-level Interface Definition

#### Core Responsibilities

`CacheOperationSource` serves as the top-level interface of the Spring Cache system, defining the core contract for obtaining cache operation metadata.

#### Key Design Pattern

Adopts the **Strategy Pattern**, providing a unified interface for different cache operation acquisition strategies (such as annotation-based, XML configuration, etc.).

#### Source Code Analysis Key Points

**Interface Definition Analysis:**

```java
public interface CacheOperationSource {

    // Core method: get cache operation collection for a method
    @Nullable
    Collection<CacheOperation> getCacheOperations(Method method, @Nullable Class<?> targetClass);

    // Optimization method: determine if a class is a candidate to avoid unnecessary method traversal
    default boolean isCandidateClass(Class<?> targetClass) {
        return true;
    }
}
```

**Method Signature Interpretation:**

1. **`getCacheOperations(Method method, @Nullable Class<?> targetClass)`**

- **Input parameters**:
    - `method`: The target method to be analyzed, never null
    - `targetClass`: The target class, may be null (when null, use the method's declaring class)
- **Return value**: `Collection<CacheOperation>` - All cache operations associated with this method, returns null if no cache operations are found
- **Semantics**: This is the entry point of the entire caching framework, responsible for converting method calls into specific cache operation instructions

2. **`isCandidateClass(Class<?> targetClass)`**

- **Optimization purpose**: Quickly determine if a class might contain cache annotations before traversing all methods of the class
- **Performance consideration**: Returning false can skip the entire class directly, avoiding expensive method-level checks
- **Default implementation**: Returns true, meaning complete check is needed (conservative strategy)

### 2. AbstractFallbackCacheOperationSource - Abstract Skeleton Implementation

#### Core Responsibilities

`AbstractFallbackCacheOperationSource` serves as a skeleton implementation, providing caching mechanisms and fallback lookup strategies, and is a classic application of the template method pattern.

#### Key Design Pattern

Adopts the **Template Method Pattern**, defining the algorithm skeleton for cache operation acquisition, delaying specific lookup logic to subclass implementations.

#### Source Code Analysis Key Points

**Core Field Analysis:**

```java
public abstract class AbstractFallbackCacheOperationSource implements CacheOperationSource {

    // Empty marker, used to mark methods without cache operations found, avoiding repeated lookups
    private static final Collection<CacheOperation> NULL_CACHING_MARKER = Collections.emptyList();

    // Operation cache: avoid repeated parsing of cache operations for the same method
    // Key: MethodClassKey(method, targetClass)
    // Value: Collection<CacheOperation> or NULL_CACHING_MARKER
    private final Map<Object, Collection<CacheOperation>> operationCache = new ConcurrentHashMap<>(1024);
}
```

**Caching Mechanism Design Analysis:**

1. **Why is `operationCache` needed?**

- **Performance optimization**: Annotation parsing is a relatively expensive operation (involving reflection, annotation lookup, etc.)
- **Frequent calls**: The same method will be called multiple times during application runtime
- **Immutability**: Cache operations of methods are immutable during runtime, suitable for caching

2. **Purpose of `NULL_CACHING_MARKER`:**

- **Avoid repeated lookup**: For methods that don't contain cache annotations, avoid the complete parsing process every time
- **State distinction**: Distinguish between "not yet looked up" and "looked up but not found" states
- **Memory optimization**: Use singleton empty collection, saving memory space

**getCacheOperations Method Implementation Analysis:**

```java
@Override
@Nullable
public Collection<CacheOperation> getCacheOperations(Method method, @Nullable Class<?> targetClass) {
    // 1. Exclude Object class methods (such as toString, equals, etc.)
    if (method.getDeclaringClass() == Object.class) {
        return null;
    }

    // 2. Generate cache key
    Object cacheKey = getCacheKey(method, targetClass);

    // 3. Check cache
    Collection<CacheOperation> cached = this.operationCache.get(cacheKey);

    if (cached != null) {
        // 4. Cache hit: return actual result or null (if it's NULL_CACHING_MARKER)
        return (cached != NULL_CACHING_MARKER ? cached : null);
    }
    else {
        // 5. Cache miss: execute actual lookup logic
        Collection<CacheOperation> cacheOps = computeCacheOperations(method, targetClass);

        // 6. Cache result
        if (cacheOps != null) {
            this.operationCache.put(cacheKey, cacheOps);
        }
        else {
            // Cache "not found" result, avoid repeated lookup
            this.operationCache.put(cacheKey, NULL_CACHING_MARKER);
        }
        return cacheOps;
    }
}
```

**Cache Key Generation Strategy:**

```java
protected Object getCacheKey(Method method, @Nullable Class<?> targetClass) {
    return new MethodClassKey(method, targetClass);
}
```

- **Uniqueness guarantee**: `MethodClassKey` ensures different methods produce different keys, same methods produce same keys
- **Method overloading support**: Can correctly distinguish method overloading cases
- **Proxy compatibility**: Considers AOP proxy cases, `targetClass` might be different from `method.getDeclaringClass()`

**Fallback Lookup Strategy Analysis:**

```java
@Nullable
private Collection<CacheOperation> computeCacheOperations(Method method, @Nullable Class<?> targetClass) {
    // 1. Public method check
    if (allowPublicMethodsOnly() && !Modifier.isPublic(method.getModifiers())) {
        return null;
    }

    // 2. Get the most specific method (handle interface proxy cases)
    Method specificMethod = AopUtils.getMostSpecificMethod(method, targetClass);

    // 3. Four-level fallback lookup strategy:

    // First level: lookup annotations on target method
    Collection<CacheOperation> opDef = findCacheOperations(specificMethod);
    if (opDef != null) {
        return opDef;
    }

    // Second level: lookup annotations on target class
    opDef = findCacheOperations(specificMethod.getDeclaringClass());
    if (opDef != null && ClassUtils.isUserLevelMethod(method)) {
        return opDef;
    }

    // Third level: if method is different, lookup annotations on original method
    if (specificMethod != method) {
        opDef = findCacheOperations(method);
        if (opDef != null) {
            return opDef;
        }

        // Fourth level: lookup annotations on original method's declaring class
        opDef = findCacheOperations(method.getDeclaringClass());
        if (opDef != null && ClassUtils.isUserLevelMethod(method)) {
            return opDef;
        }
    }

    return null;
}
```

**Design Philosophy of Fallback Strategy:**

1. **Decreasing priority**: Method-level annotations > Class-level annotations > Interface method annotations > Interface class annotations
2. **Proximity principle**: Annotations closer to the actual call point have higher priority
3. **Override mechanism**: Method-level annotations completely override class-level annotations, not merge
4. **Proxy compatibility**: Correctly handle JDK dynamic proxy and CGLIB proxy cases

**Template Method Manifestation:**

```java
// Abstract methods: specific lookup logic implemented by subclasses
@Nullable
protected abstract Collection<CacheOperation> findCacheOperations(Class<?> clazz);

@Nullable
protected abstract Collection<CacheOperation> findCacheOperations(Method method);
```

### 3. AnnotationCacheOperationSource - Standard Annotation Parsing Implementation

#### Core Responsibilities

`AnnotationCacheOperationSource` serves as an annotation-based cache operation parser, using the strategy pattern to collaborate with multiple `CacheAnnotationParser` instances, supporting different types of cache annotations.

#### Key Design Pattern

Adopts **Strategy Pattern + Composition Pattern**, combining multiple annotation parsing strategies to support different annotation systems (such as Spring standard annotations, JCache annotations, etc.).

#### Source Code Analysis Key Points

**Core Fields and Constructor Analysis:**

```java
public class AnnotationCacheOperationSource extends AbstractFallbackCacheOperationSource implements Serializable {

    private final boolean publicMethodsOnly;
    private final Set<CacheAnnotationParser> annotationParsers;

    // Default constructor: only supports public methods, uses Spring standard annotation parser
    public AnnotationCacheOperationSource() {
        this(true);
    }

    // Basic constructor: configure method visibility, default uses Spring standard annotation parser
    public AnnotationCacheOperationSource(boolean publicMethodsOnly) {
        this.publicMethodsOnly = publicMethodsOnly;
        this.annotationParsers = Collections.singleton(new SpringCacheAnnotationParser());
    }

    // Custom parser constructor: supports single custom parser
    public AnnotationCacheOperationSource(CacheAnnotationParser annotationParser) {
        this.publicMethodsOnly = true;
        Assert.notNull(annotationParser, "CacheAnnotationParser must not be null");
        this.annotationParsers = Collections.singleton(annotationParser);
    }

    // Multiple parser constructor: supports multiple parser combinations
    public AnnotationCacheOperationSource(Set<CacheAnnotationParser> annotationParsers) {
        this.publicMethodsOnly = true;
        Assert.notEmpty(annotationParsers, "At least one CacheAnnotationParser needs to be specified");
        this.annotationParsers = annotationParsers;
    }
}
```

**Constructor Design Analysis:**

1. **Progressive complexity**: From simple default configuration to fully customized configuration
2. **Reasonable defaults**: Default to only handle public methods, use Spring standard parser
3. **Extensibility support**: Support adding custom parsers, support multiple parser combinations
4. **Parameter validation**: Ensure parser set is not empty, demonstrating defensive programming

**Candidate Class Check Implementation:**

```java
@Override
public boolean isCandidateClass(Class<?> targetClass) {
    for (CacheAnnotationParser parser : this.annotationParsers) {
        if (parser.isCandidateClass(targetClass)) {
            return true;
        }
    }
    return false;
}
```

- **Short-circuit optimization**: Returns true if any parser considers it a candidate class
- **Delegation pattern**: Delegate specific judgment logic to each parser
- **Performance optimization**: Avoid expensive method traversal for unrelated classes

**Core Parsing Method Implementation:**

```java
@Override
@Nullable
protected Collection<CacheOperation> findCacheOperations(Class<?> clazz) {
    return determineCacheOperations(parser -> parser.parseCacheAnnotations(clazz));
}

@Override
@Nullable
protected Collection<CacheOperation> findCacheOperations(Method method) {
    return determineCacheOperations(parser -> parser.parseCacheAnnotations(method));
}
```

**Core Implementation of Strategy Pattern:**

```java
@Nullable
protected Collection<CacheOperation> determineCacheOperations(CacheOperationProvider provider) {
    Collection<CacheOperation> ops = null;

    // Iterate through all annotation parsers
    for (CacheAnnotationParser parser : this.annotationParsers) {
        // Use current parser to parse annotations
        Collection<CacheOperation> annOps = provider.getCacheOperations(parser);

        if (annOps != null) {
            if (ops == null) {
                // First time finding operations
                ops = annOps;
            }
            else {
                // Merge results from multiple parsers
                Collection<CacheOperation> combined = new ArrayList<>(ops.size() + annOps.size());
                combined.addAll(ops);
                combined.addAll(annOps);
                ops = combined;
            }
        }
    }
    return ops;
}
```

**Functional Interface Design:**

```java
@FunctionalInterface
protected interface CacheOperationProvider {
    @Nullable
    Collection<CacheOperation> getCacheOperations(CacheAnnotationParser parser);
}
```

**Design Highlights of determineCacheOperations Method:**

1. **Functional programming**: Uses `CacheOperationProvider` functional interface, improving code reusability
2. **Lazy computation**: Creates merged collection only when needed
3. **Memory optimization**: When only one parser has results, directly return original collection, avoiding unnecessary copying
4. **Result merging**: Support merging results from multiple parsers, implementing annotation system extension

### 4. CacheAnnotationParser - Strategy Interface Extension Point

#### Core Responsibilities

`CacheAnnotationParser` serves as the strategy interface for annotation parsing, providing a powerful extension point for the Spring Cache system, supporting different annotation standards and custom annotations.

#### Key Design Pattern

Adopts **Strategy Pattern**, providing a unified interface for different annotation parsing strategies, which is key to the extensibility of the entire annotation system.

#### Source Code Analysis Key Points

**Interface Definition Analysis:**

```java
public interface CacheAnnotationParser {

    // Candidate class check: key to performance optimization
    default boolean isCandidateClass(Class<?> targetClass) {
        return true;
    }

    // Parse class-level cache annotations
    @Nullable
    Collection<CacheOperation> parseCacheAnnotations(Class<?> type);

    // Parse method-level cache annotations
    @Nullable
    Collection<CacheOperation> parseCacheAnnotations(Method method);
}
```

**Interface Design Extensibility Manifestation:**

1. **Meaning of `isCandidateClass` method:**

```java
default boolean isCandidateClass(Class<?> targetClass) {
    return true;  // Conservative default implementation
}
```

- **Performance optimization role**: Quickly filter unrelated classes before parsing annotations
- **Default implementation**: Returns true to ensure backward compatibility
- **Customization space**: Subclasses can implement quick judgment logic based on annotation characteristics

2. **Consistency of `parseCacheAnnotations` methods:**

- **Consistent method signatures**: Class and method-level parsing use the same return type
- **null semantics**: Returning null indicates no related annotations found
- **Collection return**: Supports multiple cache operations on one element (such as @Caching annotation)

**SpringCacheAnnotationParser Implementation Example:**

```java
public class SpringCacheAnnotationParser implements CacheAnnotationParser {

    @Override
    public boolean isCandidateClass(Class<?> targetClass) {
        // Check if class has Spring Cache related annotations
        return AnnotationUtils.isCandidateClass(targetClass, CACHE_OPERATION_ANNOTATIONS);
    }

    @Override
    @Nullable
    public Collection<CacheOperation> parseCacheAnnotations(Class<?> type) {
        DefaultCacheConfig defaultConfig = new DefaultCacheConfig(type);
        return parseCacheAnnotations(defaultConfig, type);
    }

    @Override
    @Nullable
    public Collection<CacheOperation> parseCacheAnnotations(Method method) {
        DefaultCacheConfig defaultConfig = new DefaultCacheConfig(method.getDeclaringClass());
        return parseCacheAnnotations(defaultConfig, method);
    }
}
```

**Value of Extension Points:**

1. **Multi-standard support**: Can simultaneously support Spring Cache annotations, JCache annotations, custom annotations
2. **Progressive migration**: Support migration from one annotation standard to another
3. **Business customization**: Support customizing special cache annotations according to business needs
4. **Third-party integration**: Third-party caching frameworks can integrate into Spring Cache system by implementing this interface

## Complete Call Chain Analysis

### Method Call Sequence Diagram

```
User Call -> AOP Proxy -> CacheInterceptor -> CacheOperationSource
    │
    └─→ AbstractFallbackCacheOperationSource.getCacheOperations()
        │
        ├─→ [Cache Check] operationCache.get(cacheKey)
        │   ├─→ [Hit] Return cached result
        │   └─→ [Miss] Continue execution
        │
        └─→ computeCacheOperations()
            │
            ├─→ [Method Check] Public method validation
            ├─→ [Specific Method] AopUtils.getMostSpecificMethod()
            │
            └─→ [Four-level fallback lookup]
                ├─→ 1. findCacheOperations(specificMethod)
                ├─→ 2. findCacheOperations(specificMethod.getDeclaringClass())
                ├─→ 3. findCacheOperations(method)
                └─→ 4. findCacheOperations(method.getDeclaringClass())
                    │
                    └─→ AnnotationCacheOperationSource.findCacheOperations()
                        │
                        └─→ determineCacheOperations()
                            │
                            └─→ for each CacheAnnotationParser
                                │
                                └─→ parser.parseCacheAnnotations()
                                    │
                                    └─→ SpringCacheAnnotationParser
                                        │
                                        ├─→ Parse @Cacheable
                                        ├─→ Parse @CacheEvict
                                        ├─→ Parse @CachePut
                                        └─→ Parse @Caching
                                            │
                                            └─→ Build CacheOperation objects
                                                │
                                                └─→ [Result Cache] operationCache.put()
                                                    │
                                                    └─→ Return final result
```

### Key Call Path Details

1. **Entry Call:**

```java
// In CacheInterceptor.invoke()
Collection<CacheOperation> operations = getCacheOperationSource()
    .getCacheOperations(method, targetClass);
```

2. **Cache Lookup:**

```java
// AbstractFallbackCacheOperationSource.getCacheOperations()
Object cacheKey = getCacheKey(method, targetClass);
Collection<CacheOperation> cached = this.operationCache.get(cacheKey);
```

3. **Fallback Parsing:**

```java
// Four-level fallback strategy
Collection<CacheOperation> opDef = findCacheOperations(specificMethod);
if (opDef != null) return opDef;
// ... other levels of fallback
```

4. **Strategy Delegation:**

```java
// AnnotationCacheOperationSource.determineCacheOperations()
for (CacheAnnotationParser parser : this.annotationParsers) {
    Collection<CacheOperation> annOps = provider.getCacheOperations(parser);
    // Merge results...
}
```

5. **Annotation Parsing:**

```java
// SpringCacheAnnotationParser.parseCacheAnnotations()
Cacheable cacheable = AnnotatedElementUtils.findMergedAnnotation(method, Cacheable.class);
if (cacheable != null) {
    ops.add(parseCacheableAnnotation(cacheable, method));
}
```

## Design Pattern Deep Analysis

### 1. Template Method Pattern Application in AbstractFallbackCacheOperationSource

**Template Structure:**

```java
public abstract class AbstractFallbackCacheOperationSource {

    // Template method: defines algorithm skeleton
    public final Collection<CacheOperation> getCacheOperations(Method method, Class<?> targetClass) {
        // 1. Preprocessing: check Object class methods
        // 2. Cache lookup
        // 3. If cache miss, call computeCacheOperations
        // 4. Result caching
    }

    // Hook method: behavior that subclasses can override
    protected boolean allowPublicMethodsOnly() {
        return false;
    }

    // Abstract methods: force subclasses to implement
    protected abstract Collection<CacheOperation> findCacheOperations(Class<?> clazz);
    protected abstract Collection<CacheOperation> findCacheOperations(Method method);
}
```

**Advantage Analysis:**

1. **Algorithm reuse**: Caching logic and fallback strategy are the same across all subclasses
2. **Clear extension points**: Subclasses only need to focus on specific annotation lookup logic
3. **Consistency guarantee**: All implementations follow the same execution flow

### 2. Strategy Pattern Application in Annotation Parsing

**Strategy Interface:**

```java
public interface CacheAnnotationParser {
    Collection<CacheOperation> parseCacheAnnotations(Class<?> type);
    Collection<CacheOperation> parseCacheAnnotations(Method method);
}
```

**Strategy Context:**

```java
public class AnnotationCacheOperationSource {
    private final Set<CacheAnnotationParser> annotationParsers;

    protected Collection<CacheOperation> determineCacheOperations(CacheOperationProvider provider) {
        // Iterate through all strategies, merge results
    }
}
```

**Concrete Strategies:**

- `SpringCacheAnnotationParser`: Handles Spring standard annotations
- `JCacheAnnotationParser`: Handles JCache standard annotations
- Custom parsers: Handle business-specific annotations

**Advantage Analysis:**

1. **Open-closed principle**: Can add new annotation standards without modifying existing code
2. **Separation of concerns**: Each parser only focuses on specific annotation types
3. **Flexible composition**: Can use multiple annotation standards simultaneously

### 3. Composite Pattern Application

**Composite Structure:**

```java
AnnotationCacheOperationSource {
    Set<CacheAnnotationParser> annotationParsers;  // Leaf node collection

    determineCacheOperations() {
        // Iterate through all leaf nodes, collect results
        for (CacheAnnotationParser parser : annotationParsers) {
            // Call leaf node processing method
        }
    }
}
```

**Advantage Analysis:**

1. **Uniform handling**: Use same interface for single parser and parser collection
2. **Transparency**: Client doesn't need to know if it's handling single parser or parser collection
3. **Extensibility**: Can dynamically add or remove parsers

## Performance Optimization Strategy Analysis

### 1. Multi-level Caching Design

**Cache Hierarchy:**

```java
// First level: Operation result cache
private final Map<Object, Collection<CacheOperation>> operationCache;

// Second level: Candidate class pre-check cache (might exist in actual implementation)
private final Map<Class<?>, Boolean> candidateCache;

// Third level: Annotation lookup result cache (in AnnotationUtils)
```

**Cache Key Design:**

```java
protected Object getCacheKey(Method method, @Nullable Class<?> targetClass) {
    return new MethodClassKey(method, targetClass);
}
```

- **Uniqueness**: Ensure different methods have different keys
- **Consistency**: Same method always produces the same key
- **Efficiency**: Based on method and class hashCode computation

### 2. Lazy Computation and Short-circuit Optimization

**Candidate Class Short-circuit:**

```java
public boolean isCandidateClass(Class<?> targetClass) {
    for (CacheAnnotationParser parser : this.annotationParsers) {
        if (parser.isCandidateClass(targetClass)) {
            return true;  // Short-circuit return
        }
    }
    return false;
}
```

**Empty Result Marker:**

```java
private static final Collection<CacheOperation> NULL_CACHING_MARKER = Collections.emptyList();

// Avoid repeated lookup for methods known to have no results
if (cached != null) {
    return (cached != NULL_CACHING_MARKER ? cached : null);
}
```

### 3. Memory Optimization

**Collection Reuse:**

```java
// Create new collection only when merging is needed
if (ops == null) {
    ops = annOps;  // Direct reference, avoid copying
}
else {
    // Create new collection only when merging is actually needed
    Collection<CacheOperation> combined = new ArrayList<>(ops.size() + annOps.size());
    combined.addAll(ops);
    combined.addAll(annOps);
    ops = combined;
}
```

**Immutable Collections:**

```java
return Collections.unmodifiableList(ops);  // Return immutable view, prevent accidental modification
```

## Extension and Customization Guide

### 1. Custom CacheAnnotationParser

```java
public class CustomCacheAnnotationParser implements CacheAnnotationParser {

    @Override
    public boolean isCandidateClass(Class<?> targetClass) {
        // Quickly check if contains custom annotations
        return AnnotationUtils.isCandidateClass(targetClass, CustomCacheable.class);
    }

    @Override
    public Collection<CacheOperation> parseCacheAnnotations(Class<?> type) {
        CustomCacheable annotation = AnnotationUtils.findAnnotation(type, CustomCacheable.class);
        if (annotation != null) {
            return Collections.singletonList(buildCacheOperation(annotation));
        }
        return null;
    }

    @Override
    public Collection<CacheOperation> parseCacheAnnotations(Method method) {
        CustomCacheable annotation = AnnotationUtils.findAnnotation(method, CustomCacheable.class);
        if (annotation != null) {
            return Collections.singletonList(buildCacheOperation(annotation));
        }
        return null;
    }

    private CacheOperation buildCacheOperation(CustomCacheable annotation) {
        // Build custom CacheOperation
        return new CacheableOperation.Builder()
            .setName(annotation.value())
            .setCacheNames(annotation.cacheNames())
            .setKey(annotation.key())
            // Set custom properties...
            .build();
    }
}
```

### 2. Custom CacheOperationSource

```java
public class CustomCacheOperationSource extends AbstractFallbackCacheOperationSource {

    private final CustomCacheAnnotationParser parser = new CustomCacheAnnotationParser();

    @Override
    protected Collection<CacheOperation> findCacheOperations(Class<?> clazz) {
        return parser.parseCacheAnnotations(clazz);
    }

    @Override
    protected Collection<CacheOperation> findCacheOperations(Method method) {
        return parser.parseCacheAnnotations(method);
    }
}
```

### 3. Configure Custom Parser

```java
@Configuration
public class CacheConfig {

    @Bean
    public CacheOperationSource cacheOperationSource() {
        Set<CacheAnnotationParser> parsers = new LinkedHashSet<>();
        parsers.add(new SpringCacheAnnotationParser());  // Keep Spring standard support
        parsers.add(new CustomCacheAnnotationParser());  // Add custom support
        return new AnnotationCacheOperationSource(parsers);
    }
}
```

## Summary

The CacheOperationSource system in Spring Cache demonstrates excellent software design principles:

1. **Single Responsibility Principle**: Each component has clear responsibility boundaries
2. **Open-Closed Principle**: Support extension without modifying existing code through strategy pattern
3. **Dependency Inversion Principle**: High-level modules depend on abstractions rather than concrete implementations
4. **Interface Segregation Principle**: Interface design is concise with clear responsibilities
5. **Liskov Substitution Principle**: Subclasses can completely replace parent classes

This design makes Spring Cache not only powerful but also highly extensible and maintainable, providing flexible solutions for various caching scenarios. By understanding the design philosophy and implementation details of these core components, we can better use Spring Cache and also learn from these design patterns to build our own extensible systems.
