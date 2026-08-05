import { describe, expect, it } from 'vitest'
import { isLocalEndpoint } from './locality'

// These cases intentionally mirror apps/api/tests/test_endpoint_locality.py — the
// badge shown to the user must agree with the verdict the server stores.
describe('isLocalEndpoint — local', () => {
  it.each([
    'http://localhost:11434/v1',
    'http://LOCALHOST:11434/v1',
    'http://127.0.0.1:11434/v1',
    'http://127.1.2.3:8080/v1',
    'http://[::1]:11434/v1',
    'localhost:11434',
    'http://192.168.1.50:11434/v1',
    'http://10.0.0.7:8000/v1',
    'http://172.16.31.4:8000/v1',
    'http://169.254.10.10:8000/v1',
    'http://[fd00::1]:11434/v1',
    'http://ollama:11434/v1',
    'http://gpu-box.internal:8000/v1',
    'http://llm.lan/v1',
    'http://server.local:11434/v1',
    'http://0.0.0.0:11434/v1',
  ])('%s', (url) => {
    expect(isLocalEndpoint(url)).toBe(true)
  })
})

describe('isLocalEndpoint — remote', () => {
  it.each([
    'https://api.openai.com/v1',
    'https://api.anthropic.com/v1',
    'https://api.mistral.ai/v1',
    'http://8.8.8.8:11434/v1',
    'http://[2001:4860:4860::8888]/v1',
    'https://ollama.example.com/v1',
    'https://my-llm.fly.dev/v1',
    'http://172.32.0.1:8000/v1', // just outside the 172.16/12 private block
    'https://evil.example.com/localhost/v1',
    'http://localhost@evil.com/v1', // userinfo trick: real host is evil.com
  ])('%s', (url) => {
    expect(isLocalEndpoint(url)).toBe(false)
  })
})

describe('isLocalEndpoint — unusable input', () => {
  it.each(['', '   ', 'not a url'])('%s is treated as remote', (url) => {
    expect(isLocalEndpoint(url)).toBe(false)
  })
})
