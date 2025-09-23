---
title: Chain of Responsibility Design Pattern Analysis
timestamp: 2025-09-23 22:57:00+08:00
series: Design Patterns
contents: true
tags: [Design Patterns, Chain of Responsibility, CacheGuard, Java, Architecture]
description: In-depth analysis of the Chain of Responsibility design pattern in CacheGuard framework's cache processing chain, exploring its design principles, core components, and best practices.
---

## Overview

The **Chain of Responsibility Pattern** is a behavioral design pattern that creates a chain of receiver objects for a request. It decouples the sender and receiver, allowing the request to be passed along the chain until one of the objects handles it.

This article uses the **CacheGuard framework’s cache processing chain** as a case study to analyze the design principles and best practices of the Chain of Responsibility pattern.

## Chain of Responsibility Architecture in CacheGuard

### 1. Core Components

#### 1.1 Handler Interface (CacheHandler)

```java
public interface CacheHandler {
    HandlerResult handle(CacheHandlerContext context);
    void setNext(CacheHandler next);
    CacheHandler getNext();
    String getName();
    int getOrder();
    boolean supports(CacheHandlerContext context);
}
```

**Design Highlights:**

* Unified handler interface `handle()`
* Chain management methods `setNext()` and `getNext()`
* Priority ordering with `getOrder()`
* Conditional filtering with `supports()`
* Clear result enumeration for chain control flow

#### 1.2 Abstract Handler (AbstractCacheHandler)

```java
public abstract class AbstractCacheHandler implements CacheHandler {
    private CacheHandler next;

    protected HandlerResult proceedToNext(CacheHandlerContext context) {
        if (next != null) {
            return next.handle(context);
        }
        return HandlerResult.CONTINUE;
    }

    protected abstract HandlerResult doHandle(CacheHandlerContext context);
}
```

**Design Highlights:**

* Encapsulates generic chain propagation logic
* Template method `proceedToNext()`
* Abstract method `doHandle()` for business logic specialization
* Hooks for cross-cutting concerns (logging, metrics, monitoring)

#### 1.3 Chain Executor (CacheHandlerChain)

```java
public class CacheHandlerChain {
    private final CacheHandler head;
    private final int size;

    public ValueWrapper execute(CacheHandlerContext context) {
        if (head == null) {
            return context.valueWrapper();
        }

        HandlerResult result = head.handle(context);
        return switch (result) {
            case HANDLED -> context.getCurrentValue();
            case BLOCKED -> null;
            case CONTINUE -> context.getCurrentValue();
        };
    }
}
```

#### 1.4 Chain Builder (CacheHandlerChainBuilder)

```java
@Component
public class CacheHandlerChainBuilder {
    private final List<CacheHandler> allHandlers;
    private final Map<String, CacheHandlerChain> chainCache = new ConcurrentHashMap<>();

    public CacheHandlerChain buildChain(CachedInvocationContext context) {
        String cacheKey = buildCacheKey(context);
        return chainCache.computeIfAbsent(cacheKey, key -> buildChainInternal(context));
    }
}
```

### 2. Concrete Handlers

#### 2.1 Bloom Filter Handler

```java
@Component
public class BloomFilterHandler extends AbstractCacheHandler {
    @Override
    protected HandlerResult doHandle(CacheHandlerContext context) {
        if (!context.invocationContext().useBloomFilter()) {
            return proceedToNext(context);
        }

        if (context.hasValue()) {
            updateBloomFilter(context);
            return proceedToNext(context);
        }

        boolean mightExist = checkBloomFilter(context);
        return mightExist ? proceedToNext(context) : HandlerResult.BLOCKED;
    }
}
```

#### 2.2 Simple Terminal Handler

```java
public class SimpleHandler extends AbstractCacheHandler {
    @Override
    protected HandlerResult doHandle(CacheHandlerContext context) {
        // Terminal fallback logic
        return HandlerResult.HANDLED;
    }

    @Override
    public int getOrder() {
        return Integer.MAX_VALUE; // Lowest priority
    }
}
```

## Design Principles of the Chain of Responsibility

### 1. Single Responsibility Principle

Each handler focuses on one concern:

* `BloomFilterHandler`: Prevents cache penetration via Bloom filter checks
* `PreRefreshHandler`: Handles pre-refresh logic
* `CacheLoadHandler`: Manages cache loading and locking
* `SimpleHandler`: Fallback terminal handler

### 2. Open/Closed Principle

* **Open for extension**: Easily add new handlers
* **Closed for modification**: Existing handlers remain unchanged

```java
// Add a new handler by extending AbstractCacheHandler
public class NewFeatureHandler extends AbstractCacheHandler {
    @Override
    protected HandlerResult doHandle(CacheHandlerContext context) {
        // New feature logic
        return proceedToNext(context);
    }
}
```

### 3. Dependency Inversion Principle

* High-level modules don’t depend on low-level modules — both depend on abstractions
* `CacheHandlerChain` depends only on the `CacheHandler` interface

### 4. Interface Segregation Principle

* The `CacheHandler` interface is concise and cohesive
* Avoids forcing implementors to depend on unused methods

## Advanced Design Features

### 1. Handler Result Control

```java
enum HandlerResult {
    CONTINUE,  // Continue with next handler
    HANDLED,   // Request fully handled, stop chain
    BLOCKED    // Stop chain, request blocked
}
```

This enables precise flow control:

* **CONTINUE** → normal progression
* **HANDLED** → early termination, success
* **BLOCKED** → early termination, rejection

### 2. Dynamic Chain Construction

```java
private List<CacheHandler> selectAndSortHandlers(CacheHandlerContext tempContext,
                                                 CachedInvocationContext invocationContext) {
    return allHandlers.stream()
            .filter(handler -> handler.supports(tempContext))
            .filter(handler -> isHandlerApplicable(handler, invocationContext))
            .sorted(Comparator.comparingInt(CacheHandler::getOrder))
            .collect(Collectors.toList());
}
```

**Advantages:**

* Dynamically select handlers based on context
* Conditional filtering and ordering
* Avoid unnecessary execution

### 3. Chain Caching Optimization

```java
public CacheHandlerChain buildChain(CachedInvocationContext context) {
    String cacheKey = buildCacheKey(context);
    return chainCache.computeIfAbsent(cacheKey, key -> buildChainInternal(context));
}
```

**Performance Gains:**

* Cache built chains to avoid repeated construction
* Generate cache key based on invocation context
* Significantly improve high-frequency calls

### 4. Operation Type Filtering

```java
@Override
public final HandlerResult handle(CacheHandlerContext context) {
    if (!shouldExecuteForOperation(context.operationType())) {
        return proceedToNext(context);
    }
    return doHandle(context);
}
```

Each handler can declare supported operation types:

* `READ` – cache read
* `REFRESH` – refresh operation
* `EVICT` – eviction operation

## Practical Use Cases

### 1. Cache Read Flow

```
Request → BloomFilterHandler → PreRefreshHandler → CacheLoadHandler → SimpleHandler
           ↓                     ↓                     ↓                   ↓
   Bloom filter check      Pre-refresh check       Cache load         Fallback
```

### 2. Handler Decision Logic

```java
// BloomFilterHandler
if (!bloomFilter.mightContain(key)) {
    return HandlerResult.BLOCKED; // Prevent penetration
}

// PreRefreshHandler
if (shouldPreRefresh(ttl)) {
    doAsyncRefresh();
}
return proceedToNext(context);

// SimpleHandler
return HandlerResult.HANDLED; // Terminal fallback
```

## Advantages of the Pattern

### 1. Flexibility

* **Dynamic composition** of handlers
* **Conditional execution** based on context
* **Order control** via priority

### 2. Extensibility

* **Add new handlers** without changing existing ones
* **Composable features** across different handlers
* **Backward compatibility** for legacy and new handlers

### 3. Maintainability

* **Separation of concerns** with single-purpose handlers
* **Independent testing** for each handler
* **Fault isolation** so one handler doesn’t affect the whole chain

### 4. Performance Optimization

* **Chain caching** to avoid rebuilding
* **Conditional filtering** to skip irrelevant handlers
* **Early termination** for efficiency

## Best Practices

### 1. Interface Design

* Clear handler result enum
* Base methods for chain management
* Support for filtering and ordering

### 2. Abstract Base Class

* Encapsulate common chain logic
* Provide cross-cutting features (logging, monitoring)
* Simplify child classes via template method pattern

### 3. Chain Construction

* Dynamic building with caching optimization
* Context-based handler filtering
* Provide validation and debugging utilities

### 4. Handler Implementation

* Follow the single responsibility principle
* Handle exceptions gracefully
* Provide detailed logs and metrics

### 5. Performance Considerations

* Cache chains to reduce rebuild overhead
* Use conditional filtering to minimize execution cost
* Support asynchronous processing for responsiveness

## Conclusion

The **CacheGuard framework’s Chain of Responsibility implementation** demonstrates modern software design best practices. With well-designed abstractions, flexible composition, and efficient execution, the pattern plays a crucial role in complex cache management scenarios.

This design not only fulfills current business requirements but also lays a solid foundation for future extensibility and optimizations. For systems dealing with complex workflows, the Chain of Responsibility offers an elegant and efficient solution.

---

Would you like me to **tighten the English into a more concise “publication style”** (shorter sentences, less repetition), or keep it as a **detailed explanatory article** like the original?
