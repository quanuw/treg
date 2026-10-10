import { expect, test } from '@playwright/test'
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
