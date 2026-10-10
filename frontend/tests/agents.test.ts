import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { markRaw, nextTick, reactive, watch } from 'vue'
import agents from '../src/state/agents.js'
import computed from '../src/state/agentsComputed.js'
import controller from '../src/state/controller.js'
import keys from '../src/state/keys.js'
import session from '../src/state/session.js'
import team from '../src/state/team.js'
import tickets from '../src/state/tickets.js'

vi.hoisted(() => vi.stubGlobal('location', { origin: 'http://localhost' }))
afterAll(() => vi.unstubAllGlobals())

const issued = (key = 7) => ({ user_id: 3, api_key_id: key, org_id: 1, name: 'bot', connected: false })
const deferred = <T = any>() => {
  let resolve!: (value: T) => void
  let reject!: (error: any) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const cleanup: (() => void)[] = []

function dashboard() {
  const vm: any = reactive({
    ...agents, ...keys, ...tickets, switchOrg: session.switchOrg,
    elements: markRaw({}), activeOrgId: 1, activeSlug: 'team', sessionMode: true,
    view: 'orgs', canAdmin: true, orgTab: 'members', newAgent: null, newApiKey: null,
    agents: [{ user_id: 3, connected: true }], agentTokens: {},
    agentName: 'bot', agentCap: -1, agentRole: 'member', agentAccessMode: 'all',
    projects: [], accessNames: [], agentProjSel: {},
    api: vi.fn().mockResolvedValue({ connected: false }),
    loadOrgAdmin: vi.fn().mockResolvedValue(undefined), loadApiKeys: vi.fn().mockResolvedValue(undefined),
    loadAll: vi.fn(), intercomUpdate: vi.fn(), resetRenameForm: vi.fn(), connected: () => true,
    get activeSlugNow() { return this.activeSlug },
    get agentConnectionTarget() { return computed.agentConnectionTarget.call(this) },
    get agentConnected() { return computed.agentConnected.call(this) },
  })
  cleanup.push(watch(() => vm.agentConnectionTarget, () => controller.watch.agentConnectionTarget.call(vm)))
  cleanup.push(watch(() => vm.activeOrgId, () => controller.watch.activeOrgId.call(vm)))
  cleanup.push(() => vm.stopAgentPoll())
  return vm
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.useRealTimers() })

test('initial Team loading still fetches the full roster; waiting polls only the new key', async () => {
  const vm = dashboard()
  vm.api.mockResolvedValue([])
  vm.loadApiKeys = keys.loadApiKeys
  await team.loadOrgAdmin.call(vm)
  expect(vm.api).toHaveBeenCalledTimes(8)
  expect(vm.api.mock.calls.map(([path]: [string]) => path)).toEqual(expect.arrayContaining([
    '/orgs/1/members', '/orgs/1/agents', '/orgs/1/agents/observed',
  ]))
  vm.api.mockClear().mockResolvedValue({ connected: false })
  vm.newAgent = issued()
  await nextTick()
  await vi.advanceTimersByTimeAsync(9000)
  expect(vm.api).toHaveBeenCalledTimes(3)
  for (const [path, options] of vm.api.mock.calls) {
    expect(path).toBe('/orgs/1/agents/3/connection?api_key_id=7')
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(options.cache).toBe('no-store')
  }
  expect(vm.loadOrgAdmin).not.toHaveBeenCalled()
})

test.each(['create', 'rotate'] as const)('%s refreshes once and detects only the issued credential', async action => {
  const vm = dashboard()
  vm.api.mockResolvedValueOnce({ ...issued(), token: 'test-token' }).mockResolvedValue({ connected: true })
  if (action === 'create') await vm.createAgent()
  else await vm.rotateAgent({ user_id: 3, name: 'bot', role: 'member', daily_call_cap: -1 }, true)
  await nextTick()
  expect(vm.loadOrgAdmin).toHaveBeenCalledTimes(1)
  expect(vm.agentConnected).toBe(false) // Lifetime roster history must not satisfy a new key.
  await vi.advanceTimersByTimeAsync(3000)
  expect(vm.agentConnected).toBe(true)
  await vi.advanceTimersByTimeAsync(120000)
  expect(vm.api).toHaveBeenCalledTimes(2)
})

test('the API Keys rotation card uses the replacement key id and stops when dismissed', async () => {
  const vm = dashboard()
  vm.api.mockResolvedValueOnce({ id: 8, secret: 'replacement' }).mockResolvedValue({ connected: false })
  await vm.keyAction({ id: 7, user_id: 3, kind: 'agent', assigned_type: 'agent', assigned_name: 'bot' }, 'rotate')
  await nextTick()
  expect(vm.loadApiKeys).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(3000)
  expect(vm.api).toHaveBeenLastCalledWith('/orgs/1/agents/3/connection?api_key_id=8', expect.anything())
  const signal = vm.api.mock.lastCall[1].signal
  vm.newApiKey = null
  await nextTick()
  expect(signal.aborted).toBe(true)
  await vi.advanceTimersByTimeAsync(9000)
  expect(vm.api).toHaveBeenCalledTimes(2)
})

test('slow responses never overlap, even when resume is called again', async () => {
  const vm = dashboard(), response = deferred()
  vm.api.mockReturnValue(response.promise)
  vm.newAgent = issued()
  await nextTick()
  await vi.advanceTimersByTimeAsync(3000)
  vm.resumeAgentPoll()
  await vi.advanceTimersByTimeAsync(60000)
  expect(vm.api).toHaveBeenCalledTimes(1)
  response.resolve({ connected: false })
  await vi.advanceTimersByTimeAsync(2999)
  expect(vm.api).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(vm.api).toHaveBeenCalledTimes(2)
})

test('leaving aborts the pending request; returning resumes and ignores the old success', async () => {
  const vm = dashboard(), old = deferred()
  vm.api.mockReturnValueOnce(old.promise).mockResolvedValue({ connected: false })
  vm.newAgent = issued()
  await nextTick()
  await vi.advanceTimersByTimeAsync(3000)
  const signal = vm.api.mock.lastCall[1].signal
  vm.view = 'catalog'
  vm.stopAgentPoll() // TeamPage.beforeUnmount
  expect(signal.aborted).toBe(true)
  await vi.advanceTimersByTimeAsync(30000)
  expect(vm.api).toHaveBeenCalledTimes(1)
  vm.view = 'orgs'
  vm.resumeAgentPoll() // TeamPage.mounted
  old.resolve({ connected: true }) // Also safe with a transport that ignores abort.
  await vi.advanceTimersByTimeAsync(3000)
  expect(vm.agentConnected).toBe(false)
  expect(vm.api).toHaveBeenCalledTimes(2)
  vm.api.mockResolvedValue({ connected: true })
  await vi.advanceTimersByTimeAsync(3000)
  expect(vm.agentConnected).toBe(true)
})

test('switching org cancels immediately and ignores stale responses even after switching back', async () => {
  const vm = dashboard(), old = deferred()
  vm.api.mockReturnValue(old.promise)
  vm.newAgent = issued()
  await nextTick()
  await vi.advanceTimersByTimeAsync(3000)
  const signal = vm.api.mock.lastCall[1].signal
  vm.switchOrg({ slug: 'other' })
  expect(signal.aborted).toBe(true)
  vm.activeOrgId = 2
  await nextTick()
  vm.switchOrg({ slug: 'team' })
  vm.activeOrgId = 1
  await nextTick()
  old.resolve({ connected: true })
  await vi.advanceTimersByTimeAsync(9000)
  expect(vm.newAgent).toBeNull()
  expect(vm.agentConnected).toBe(false)
  expect(vm.newAgent).toBeNull()
  expect(vm.api).toHaveBeenCalledTimes(1)
})

test('automatic active-org changes cancel a poll without switchOrg', async () => {
  const vm = dashboard(), response = deferred()
  vm.api.mockReturnValue(response.promise)
  vm.newAgent = issued()
  await nextTick()
  await vi.advanceTimersByTimeAsync(3000)
  const signal = vm.api.mock.lastCall[1].signal
  vm.activeOrgId = 2
  await nextTick()
  expect(signal.aborted).toBe(true)
  response.resolve({ connected: true })
  await vi.advanceTimersByTimeAsync(6000)
  expect(vm.agentConnected).toBe(false)
  expect(vm.api).toHaveBeenCalledTimes(1)
})

test('a replaced card is not updated by the previous request or stopped by its completion', async () => {
  const vm = dashboard(), old = deferred()
  vm.api.mockReturnValueOnce(old.promise).mockResolvedValue({ connected: false })
  vm.newAgent = issued()
  await nextTick()
  await vi.advanceTimersByTimeAsync(3000)
  const signal = vm.api.mock.lastCall[1].signal
  vm.newAgent = issued(8)
  await nextTick()
  expect(signal.aborted).toBe(true)
  old.reject(new DOMException('Aborted', 'AbortError'))
  await vi.advanceTimersByTimeAsync(6000)
  expect(vm.agentConnected).toBe(false)
  expect(vm.api).toHaveBeenCalledTimes(3)
  expect(vm.api).toHaveBeenLastCalledWith('/orgs/1/agents/3/connection?api_key_id=8', expect.anything())
})

test.each([401, 403, 404])('status %s stops a no-longer-authorized or removed key', async status => {
  const vm = dashboard()
  vm.api.mockRejectedValue({ status })
  vm.newAgent = issued()
  await nextTick()
  await vi.advanceTimersByTimeAsync(120000)
  expect(vm.api).toHaveBeenCalledTimes(1)
  expect(vm.agentConnected).toBe(false)
})

test.each([false, true])('unconnected/error polling is bounded at 40 attempts (error=%s)', async error => {
  const vm = dashboard()
  if (error) vm.api.mockRejectedValue({ status: 503 })
  vm.newAgent = issued()
  await nextTick()
  await vi.advanceTimersByTimeAsync(240000)
  expect(vm.api).toHaveBeenCalledTimes(40)
  expect(vm.elements.agentPoll).toBeNull()
})

describe('credential mutations in flight', () => {
  test.each(['create', 'rotate', 'keyAction'] as const)('%s cannot publish an old org response after a switch', async action => {
    const vm = dashboard(), response = deferred()
    vm.api.mockReturnValue(response.promise)
    const done = action === 'create' ? vm.createAgent() : action === 'rotate'
      ? vm.rotateAgent({ user_id: 3, name: 'bot', role: 'member' }, true)
      : vm.keyAction({ id: 7, user_id: 3, kind: 'agent', assigned_type: 'agent' }, 'rotate')
    vm.switchOrg({ slug: 'other' })
    vm.switchOrg({ slug: 'team' })
    response.resolve({ ...issued(), id: 8, token: 'test-token', secret: 'replacement' })
    await done
    await nextTick()
    await vi.advanceTimersByTimeAsync(9000)
    expect(vm.newAgent).toBeNull()
    expect(vm.newApiKey).toBeNull()
    expect(vm.agentBusy).toBe(false)
    expect(vm.keyBusy).toBe(false)
    expect(vm.api).toHaveBeenCalledTimes(1)
    expect(vm.loadOrgAdmin).not.toHaveBeenCalled()
    expect(vm.loadApiKeys).not.toHaveBeenCalled()
  })

  test('creation finishing off-page saves its card without restarting the poll', async () => {
    const vm = dashboard(), response = deferred()
    vm.api.mockReturnValueOnce(response.promise).mockResolvedValue({ connected: true })
    const done = vm.createAgent()
    vm.view = 'catalog'
    vm.stopAgentPoll()
    response.resolve({ ...issued(), token: 'test-token' })
    await done
    await nextTick()
    await vi.advanceTimersByTimeAsync(9000)
    expect(vm.api).toHaveBeenCalledTimes(1)
    vm.view = 'orgs'
    vm.resumeAgentPoll()
    await vi.advanceTimersByTimeAsync(3000)
    expect(vm.agentConnected).toBe(true)
  })
})
