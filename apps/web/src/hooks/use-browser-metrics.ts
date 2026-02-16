import { useState, useEffect, useCallback } from 'react'
import { getPyodideStatus, onPyodideStatusChange } from '@/lib/runtimes/pyodide-engine'
import { getWebRStatus, onWebRStatusChange } from '@/lib/runtimes/webr-engine'
import type { RuntimeStatus } from '@/lib/runtimes/types'

interface MemoryInfo {
  usedMB: number
  totalMB: number | null // null if unavailable (non-Chrome)
  pct: number | null
}

interface StorageInfo {
  usedMB: number
  quotaMB: number
  pct: number
}

export interface BrowserMetrics {
  memory: MemoryInfo
  storage: StorageInfo | null
  cpuCores: number
  sessionUptime: string
  runtimes: {
    pyodide: RuntimeStatus
    webR: RuntimeStatus
  }
}

const SESSION_START = Date.now()

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function getMemoryInfo(): MemoryInfo {
  // Chrome-only: performance.memory
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number }
  }
  if (perf.memory) {
    const usedMB = Math.round(perf.memory.usedJSHeapSize / 1024 / 1024)
    const totalMB = Math.round(perf.memory.jsHeapSizeLimit / 1024 / 1024)
    return {
      usedMB,
      totalMB,
      pct: Math.round((usedMB / totalMB) * 100),
    }
  }
  return { usedMB: 0, totalMB: null, pct: null }
}

async function getStorageInfo(): Promise<StorageInfo | null> {
  if (!navigator.storage?.estimate) return null
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate()
    const usedMB = Math.round(usage / 1024 / 1024)
    const quotaMB = Math.round(quota / 1024 / 1024)
    return {
      usedMB,
      quotaMB,
      pct: quotaMB > 0 ? Math.round((usedMB / quotaMB) * 100) : 0,
    }
  } catch {
    return null
  }
}

export function useBrowserMetrics(intervalMs = 5000): BrowserMetrics {
  const [metrics, setMetrics] = useState<BrowserMetrics>(() => ({
    memory: getMemoryInfo(),
    storage: null,
    cpuCores: navigator.hardwareConcurrency || 0,
    sessionUptime: formatUptime(Date.now() - SESSION_START),
    runtimes: {
      pyodide: getPyodideStatus(),
      webR: getWebRStatus(),
    },
  }))

  const refresh = useCallback(async () => {
    const memory = getMemoryInfo()
    const storage = await getStorageInfo()
    setMetrics((prev) => ({
      ...prev,
      memory,
      storage,
      sessionUptime: formatUptime(Date.now() - SESSION_START),
      runtimes: {
        pyodide: getPyodideStatus(),
        webR: getWebRStatus(),
      },
    }))
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, intervalMs)
    return () => clearInterval(id)
  }, [refresh, intervalMs])

  // Listen to runtime status changes for immediate updates
  useEffect(() => {
    const updateRuntimes = () => {
      setMetrics((prev) => ({
        ...prev,
        runtimes: {
          pyodide: getPyodideStatus(),
          webR: getWebRStatus(),
        },
      }))
    }
    onPyodideStatusChange(updateRuntimes)
    onWebRStatusChange(updateRuntimes)
    return () => {
      onPyodideStatusChange(() => {})
      onWebRStatusChange(() => {})
    }
  }, [])

  return metrics
}
