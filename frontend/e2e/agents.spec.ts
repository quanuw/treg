import { expect, test, type Page } from '@playwright/test'
import { signIn } from './helpers'

test('agent setup polls only connection status across return and both rotation controls', async ({ page }) => {
  await signIn(page, 'agent-poll')
  const navigation = page.getByRole('navigation', { name: 'Primary navigation' })
  await navigation.getByRole('button', { name: 'Team', exact: true }).click()
  await page.getByRole('button', { name: 'Team settings', exact: true }).click()
  const archiveSetting = page.waitForResponse(r => /\/orgs\/\d+\/settings$/.test(r.url()) && r.request().method() === 'PATCH')
  await page.getByTitle('archive on — click to opt out', { exact: true }).getByRole('checkbox').uncheck()
  expect((await (await archiveSetting).json()).archive).toBe(false)
  await page.getByRole('button', { name: 'Members', exact: true }).click()
  await page.getByRole('button', { name: '＋ Add agent' }).click()
  await page.getByPlaceholder('ci-bot').fill('poll-bot')
  await page.getByText('All tools', { exact: true }).first().click()
  const created = page.waitForResponse(r => /\/orgs\/\d+\/agents$/.test(r.url()) && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const agent = await (await created).json()
  await expect(page.getByText('Token for poll-bot', { exact: false })).toBeVisible()

  await navigation.getByRole('button', { name: 'Catalog', exact: true }).click()
  await navigation.getByRole('button', { name: 'Team', exact: true }).click()
  // Let the page's own roster load on return finish first, so only the poll can see the check-in.
  await page.waitForLoadState('networkidle')
  const requests: string[] = []
  page.on('request', request => {
    if (request.method() === 'GET' && /\/orgs\/\d+\//.test(request.url())) requests.push(new URL(request.url()).pathname)
  })
  const checkin = await page.request.post('/agents/checkin', { headers: { 'X-Treg-Token': agent.token } })
  expect(checkin.ok()).toBe(true)
  await expect(page.getByText(/connected .*poll-bot called in as itself/)).toBeVisible({ timeout: 8000 })
  expect(requests.length).toBeGreaterThan(0)
  expect(requests.every(path => path.endsWith(`/agents/${agent.user_id}/connection`))).toBe(true)
  await page.getByRole('button', { name: 'Done', exact: true }).click()

  // An existing lifetime check-in cannot confirm a freshly rotated credential.
  await page.getByRole('button', { name: 'Rotate', exact: true }).click()
  const rotated = page.waitForResponse(r => /\/orgs\/\d+\/agents$/.test(r.url()) && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Confirm rotate', exact: true }).click()
  const replacement = await (await rotated).json()
  await expect(page.getByText('waiting for its first check-in…', { exact: true })).toBeVisible()
  await page.waitForResponse(r => r.url().includes(`/connection?api_key_id=${replacement.api_key_id}`))
  await expect(page.getByText(/connected .*poll-bot called in as itself/)).not.toBeVisible()
  expect((await page.request.post('/agents/checkin', { headers: { 'X-Treg-Token': replacement.token } })).ok()).toBe(true)
  await expect(page.getByText(/connected .*poll-bot called in as itself/)).toBeVisible({ timeout: 8000 })

  await page.getByRole('button', { name: 'I’ve updated poll-bot', exact: true }).click()
  await page.getByRole('button', { name: 'API Keys', exact: true }).click()
  await page.getByRole('row').filter({ hasText: 'poll-bot' }).getByRole('button', { name: 'Rotate', exact: true }).click()
  const keyRotation = page.waitForResponse(r => /\/api-keys\/\d+\/rotate$/.test(r.url()) && r.request().method() === 'POST')
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm rotate', exact: true }).click()
  const key = await (await keyRotation).json()
  await expect(page.getByText('New key for poll-bot', { exact: true })).toBeVisible()
  await page.waitForResponse(r => r.url().includes(`/connection?api_key_id=${key.id}`))
  await expect(page.getByText('waiting for its first check-in…', { exact: true })).toBeVisible()
  expect((await page.request.post('/agents/checkin', { headers: { 'X-Treg-Token': key.secret } })).ok()).toBe(true)
  await expect(page.getByText(/connected .*poll-bot called in as itself/)).toBeVisible({ timeout: 8000 })
  await page.getByRole('button', { name: 'Team settings', exact: true }).click()
  await expect(page.getByTitle('archive off — click to opt back in', { exact: true }).getByRole('checkbox')).not.toBeChecked()
})

async function switchTeam(page: Page, name: string) {
  await page.getByRole('button', { name: 'Teams' }).click()
  const button = page.getByRole('button', { name: 'Switch', exact: true })
  await page.locator('div').filter({ has: page.getByText(name, { exact: true }) }).filter({ has: button })
    .last().getByRole('button', { name: 'Switch', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Teams' })).toContainText(name)
}

for (const action of ['create', 'rotate', 'keyAction'] as const) {
  test(`${action}: a committed response arriving in another team remains recoverable`, async ({ page }) => {
    await signIn(page, `issued-${action}`, 'Issuing team')
    const orgs = await (await page.request.get('/orgs')).json()
    const first = orgs.find((org: any) => org.name === 'Issuing team')
    await page.request.post('/orgs', { data: { name: 'Other team' } })
    let old: any
    if (action !== 'create') {
      old = await (await page.request.post(`/orgs/${first.org_id}/agents`, {
        headers: { 'X-Treg-Org': first.slug }, data: { name: 'retained-bot' },
      })).json()
    }
    await page.reload()
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'Team', exact: true }).click()
    if (action === 'keyAction') await page.getByRole('button', { name: 'API Keys', exact: true }).click()
    else if (action === 'create') {
      await page.getByRole('button', { name: '＋ Add agent' }).click()
      await page.getByPlaceholder('ci-bot').fill('retained-bot')
      await page.getByText('All tools', { exact: true }).first().click()
    }

    const path = action === 'keyAction' ? `/orgs/${first.org_id}/api-keys/${old.api_key_id}/rotate` : `/orgs/${first.org_id}/agents`
    let release!: () => void, committed!: () => void, result: any, postCount = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    const wrote = new Promise<void>(resolve => { committed = resolve })
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== 'POST') return route.fallback()
      postCount++
      const response = await route.fetch() // server commits before navigation; delay only delivery
      expect(response.ok()).toBe(true)
      result = await response.json()
      committed()
      await gate
      await route.fulfill({ response })
    })
    const received = page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === 'POST')
    if (action === 'create') await page.getByRole('button', { name: 'Create', exact: true }).click()
    else {
      await page.getByRole('row').filter({ hasText: 'retained-bot' }).getByRole('button', { name: 'Rotate', exact: true }).click()
      await page.getByRole('button', { name: 'Confirm rotate', exact: true }).click()
    }
    await wrote
    if (old) expect((await page.request.post('/agents/checkin', { headers: { 'X-Treg-Token': old.token } })).status()).toBe(401)
    await switchTeam(page, 'Other team')
    release(); await received
    const secret = result.token || result.secret
    await expect(page.locator('body')).not.toContainText(secret)
    expect(await page.locator('input').evaluateAll((inputs, value) => inputs.some(input => input.value === value), secret)).toBe(false)

    await switchTeam(page, 'Issuing team')
    const card = page.locator('.card').filter({ hasText: action === 'keyAction' ? 'New key for retained-bot' : 'Token for retained-bot' })
    await expect(card.getByRole('textbox')).toHaveValue(secret)
    expect(postCount).toBe(1)
    expect(await page.evaluate(value => [...Object.values(localStorage), ...Object.values(sessionStorage)]
      .some(stored => stored.includes(value)), secret)).toBe(false)
    await card.getByRole('button', { name: action === 'create' ? 'Done' : 'I’ve updated retained-bot', exact: true }).click()
    await switchTeam(page, 'Other team'); await switchTeam(page, 'Issuing team')
    await expect(card).not.toBeVisible()
    expect(postCount).toBe(1)
  })
}
