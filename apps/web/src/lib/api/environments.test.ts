import { beforeEach, describe, expect, it, vi } from 'vitest'

const requests: string[] = []
vi.mock('@/lib/api-client', () => ({
  apiRequest: async (path: string) => {
    requests.push(path)
  },
}))

import { cancelJob } from './environments'

describe('cancelJob', () => {
  beforeEach(() => { requests.length = 0 })

  it('addresses only the job it names', async () => {
    await cancelJob('../other/route?x=')
    expect(requests).toEqual(['/jobs/..%2Fother%2Froute%3Fx%3D/cancel'])
  })

  it('leaves a real job id as it is', async () => {
    await cancelJob('6f1c2d3e-1111-4222-8333-abcdefabcdef')
    expect(requests).toEqual(['/jobs/6f1c2d3e-1111-4222-8333-abcdefabcdef/cancel'])
  })
})
