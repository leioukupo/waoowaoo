export interface SlidingWindowThrottle {
  /** Record one request. Returns null when allowed, otherwise retry seconds. */
  allow(key: string, now?: number): number | null
}

/**
 * 进程内滑动窗口限流。
 *
 * 初始化探测接口在 Redis 尚未配置时就要可用，因此不能依赖 Redis 计数器，
 * 这里维护一个每客户端的内存窗口（单实例部署下足够）。
 */
export function createSlidingWindowThrottle(windowMs: number, maxRequests: number): SlidingWindowThrottle {
  const hits = new Map<string, number[]>()
  let lastSweep = Date.now()

  return {
    allow(key, now = Date.now()) {
      if (now - lastSweep > windowMs) {
        hits.clear()
        lastSweep = now
      }
      const windowStart = now - windowMs
      const previous = (hits.get(key) ?? []).filter((at) => at > windowStart)
      if (previous.length >= maxRequests) {
        hits.set(key, previous)
        return Math.max(1, Math.ceil((previous[0] + windowMs - now) / 1000))
      }
      previous.push(now)
      hits.set(key, previous)
      return null
    },
  }
}
