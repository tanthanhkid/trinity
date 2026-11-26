import { clusterModeWarnings } from '../single-process'

describe('clusterModeWarnings', () => {
  it('một tiến trình: không cảnh báo', () => {
    expect(clusterModeWarnings({})).toEqual([])
    expect(clusterModeWarnings({ NODE_APP_INSTANCE: '0', pm_id: '0' })).toEqual([])
  })
  it('PM2 cluster: cảnh báo', () => {
    expect(clusterModeWarnings({ NODE_APP_INSTANCE: '1' })).toHaveLength(1)
    expect(clusterModeWarnings({ pm_id: '3' })).toHaveLength(1)
    expect(clusterModeWarnings({ instances: '4' })).toHaveLength(1)
  })
})
