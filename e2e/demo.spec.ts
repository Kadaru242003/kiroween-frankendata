import { expect, test, type Page } from '@playwright/test'

/**
 * The full demo in a real browser: month one stitch, species chip, Autopsy,
 * save recipe, reset, month two, apply recipe.
 */

async function stitchEverything(page: Page) {
  await page.getByRole('button', { name: 'Stitch tables' }).click()
  await page.getByRole('button', { name: 'Approve all suggestions' }).click()
  await page.getByRole('button', { name: /Confirm & stitch/ }).click()
  await page.getByRole('button', { name: 'Apply & stitch' }).click()
}

test('month one, recipe, month two', async ({ page }) => {
  await page.goto('/')

  // Month one: load, stitch, approve everything, confirm, apply.
  await page.getByRole('button', { name: 'Load mismatched demo' }).click()
  await expect(page.getByRole('region', { name: 'Preview of monsters', exact: true })).toBeVisible()
  await stitchEverything(page)
  const result = page.getByRole('region', { name: 'Stitched result preview' })
  await expect(result.getByText('12 rows', { exact: true })).toBeVisible()

  // Ask the Lab starter chip for species on the stitched result.
  await page
    .getByRole('button', { name: 'How many rows per Species in stitch_1_result?' })
    .click()
  const ask = page.getByRole('region', { name: 'Ask the Lab' })
  await expect(ask.getByRole('row', { name: /Swamp Wraith\s+3/ })).toBeVisible()

  // "Ask about this" prefills the Ask input for that table.
  await page.getByRole('button', { name: 'Ask about monsters' }).click()
  await expect(page.getByRole('textbox', { name: 'Question' })).toHaveValue('In monsters: ')

  // One follow-up question. It needs the AI proxy, which the dev server does
  // not provide, so skip this step gracefully when AI is off.
  const aiOff = await page.getByText('AI is off here. Starter questions still work without it.').isVisible()
  if (aiOff) {
    test.info().annotations.push({
      type: 'skipped-step',
      description: 'Follow-up question skipped: the AI proxy is not available in this environment.',
    })
  } else {
    await page.getByRole('textbox', { name: 'Question' }).fill('now only the Swamp Wraith ones')
    await page.getByRole('button', { name: 'Ask', exact: true }).click()
    await expect(
      page.getByLabel('Latest answer').or(page.getByRole('alert')).or(page.getByRole('status').filter({ hasText: 'unavailable' })),
    ).toBeVisible()
  }

  // Autopsy on monsters.
  await page.getByRole('button', { name: 'Autopsy of monsters' }).click()
  await expect(page.getByLabel('Health score 81 out of 100')).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).first().click()

  // Save the recipe.
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save recipe' }).click()
  const download = await downloadPromise
  const recipePath = test.info().outputPath('recipe.json')
  await download.saveAs(recipePath)

  // Month two: reset, load next month's files, apply the recipe.
  await page.getByRole('button', { name: 'Reset lab' }).click()
  // Reset is asynchronous: wait until every table is gone before loading again.
  await expect(page.getByRole('region', { name: /^Preview of/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Lab: next month' }).click()
  await expect(page.getByRole('region', { name: 'Preview of monsters', exact: true })).toBeVisible()
  await page.getByLabel('Apply recipe (JSON file)').setInputFiles(recipePath)
  await expect(page.getByText(/steps? pre-approved/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Review in stitching table' }).click()
  await page.getByRole('button', { name: /Confirm & stitch/ }).click()
  await page.getByRole('button', { name: 'Apply & stitch' }).click()
  await expect(
    page.getByRole('region', { name: 'Stitched result preview' }).getByText('12 rows', { exact: true }),
  ).toBeVisible()
})

test('business demo: stitch on the email key, revenue by region, Autopsy', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Load business demo' }).click()
  await expect(page.getByRole('region', { name: 'Preview of crm_customers', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Preview of billing_invoices', exact: true })).toBeVisible()

  await stitchEverything(page)
  const result = page.getByRole('region', { name: 'Stitched result preview' })
  await expect(result.getByText('48 rows', { exact: true })).toBeVisible()

  await page
    .getByRole('button', { name: 'What is the monthly revenue by region in crm_customers?' })
    .click()
  const ask = page.getByRole('region', { name: 'Ask the Lab' })
  await expect(ask.getByRole('row', { name: /North America\s+34/ })).toBeVisible()

  await page.getByRole('button', { name: 'Autopsy of crm_customers' }).click()
  await expect(page.getByLabel('Health score 79 out of 100')).toBeVisible()
})

test("business month two: the March recipe applies to next month's business files", async ({ page }) => {
  await page.goto('/')

  // March: load, stitch on the email key, save the recipe.
  await page.getByRole('button', { name: 'Load business demo' }).click()
  await expect(page.getByRole('region', { name: 'Preview of crm_customers', exact: true })).toBeVisible()
  await stitchEverything(page)
  await expect(
    page.getByRole('region', { name: 'Stitched result preview' }).getByText('48 rows', { exact: true }),
  ).toBeVisible()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save recipe' }).click()
  const download = await downloadPromise
  const recipePath = test.info().outputPath('business-recipe.json')
  await download.saveAs(recipePath)

  // April: reset, load next month's business files, apply the recipe.
  await page.getByRole('button', { name: 'Reset lab' }).click()
  await expect(page.getByRole('region', { name: /^Preview of/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Business: next month' }).click()
  await expect(page.getByRole('region', { name: 'Preview of crm_customers', exact: true })).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Preview of billing_invoices_2026_04', exact: true }),
  ).toBeVisible()
  await page.getByLabel('Apply recipe (JSON file)').setInputFiles(recipePath)
  // Every step pre-approved, nothing left over.
  await expect(page.getByText(/steps? pre-approved, 0 not applied/).first()).toBeVisible()
  // The status is shown once, as one line, with the review button; centered under the toolbar.
  await expect(page.getByText(/pre-approved/)).toHaveCount(1)
  await expect(page.getByText('Recipe applied: ', { exact: false })).toHaveCount(1)
  const line = (await page.getByText(/pre-approved/).boundingBox())!
  const bar = (await page.getByRole('region', { name: 'Lab toolbar' }).boundingBox())!
  expect(Math.abs(line.x + line.width / 2 - (bar.x + bar.width / 2))).toBeLessThan(3)
  await expect(page.getByRole('region', { name: 'Recipe items not applied' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Review in stitching table' }).click()
  await page.getByRole('button', { name: /Confirm & stitch/ }).click()
  await page.getByRole('button', { name: 'Apply & stitch' }).click()
  // One row per April invoice, and no fan-out warning.
  const result = page.getByRole('region', { name: 'Stitched result preview' })
  await expect(result.getByText('24 rows', { exact: true })).toBeVisible()
  await expect(page.getByText(/fan/i)).toHaveCount(0)
})

test('Load demo menu order, and a demo replaces the loaded tables while Add files adds on top', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Load business demo' }).click()
  await expect(page.getByRole('region', { name: 'Preview of crm_customers', exact: true })).toBeVisible()

  await page.getByRole('button', { name: /^Load demo/ }).click()
  await expect(page.getByRole('menuitem')).toHaveText([
    'Business (loaded)',
    'Business: next month',
    'Lab',
    'Mismatched',
    'Lab: next month',
  ])

  // A demo replaces the loaded tables.
  await page.getByRole('menuitem', { name: 'Lab', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Preview of monsters', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Preview of crm_customers', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Preview of billing_invoices', exact: true })).toHaveCount(0)

  // Add files still adds on top.
  await page.getByLabel('Add files').setInputFiles({
    name: 'extra.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('id,label\n1,a\n2,b\n'),
  })
  await expect(page.getByRole('region', { name: 'Preview of extra', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Preview of monsters', exact: true })).toBeVisible()
})

test('Apply recipe tooltip: hover and focus only, below the button, covering no other control', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Load business demo' }).click()
  await expect(page.getByRole('region', { name: 'Preview of crm_customers', exact: true })).toBeVisible()
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toBeHidden()
  const label = page.getByText('Apply recipe', { exact: true })
  const covered = async () => {
    const tip = (await tooltip.boundingBox())!
    const btn = (await label.boundingBox())!
    expect(tip.y).toBeGreaterThanOrEqual(btn.y + btn.height)
    const boxes = await page.locator('button:visible, a:visible, label:visible, input:visible').evaluateAll((els) =>
      els.map((el) => ({ name: (el.textContent || el.getAttribute('aria-label') || '').trim(), r: el.getBoundingClientRect() })),
    )
    for (const b of boxes) {
      if (b.r.width === 0 || b.r.height === 0 || b.name === 'Apply recipe') continue
      const overlap = tip.x < b.r.right && tip.x + tip.width > b.r.left && tip.y < b.r.bottom && tip.y + tip.height > b.r.top
      expect(overlap, 'tooltip covers: ' + b.name).toBe(false)
    }
  }
  await label.hover()
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toHaveText('Reuse a saved stitch on new files')
  await covered()
  await page.mouse.move(5, 5)
  await expect(tooltip).toBeHidden()
  await page.getByLabel('Apply recipe (JSON file)').focus()
  await expect(tooltip).toBeVisible()
  await covered()
})

test('Autopsy opens and scrolls into view after stitching and asking, on every table', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Load business demo' }).click()
  await expect(page.getByRole('region', { name: 'Preview of crm_customers', exact: true })).toBeVisible()
  await stitchEverything(page)
  await expect(
    page.getByRole('region', { name: 'Stitched result preview' }).getByText('48 rows', { exact: true }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'What is the monthly revenue by region in crm_customers?' })
    .click()
  await expect(page.getByLabel('Latest answer')).toBeVisible()

  for (const table of ['crm_customers', 'billing_invoices', 'stitch_1_result']) {
    await page.getByRole('button', { name: `Autopsy of ${table}` }).click()
    const panel = page.getByRole('region', { name: 'Autopsy case file' })
    await expect(panel.getByRole('heading', { name: table })).toBeVisible()
    await expect(panel).toBeInViewport()
    await panel.getByRole('button', { name: 'Close' }).click()
  }
  // A second click on the same card, after scrolling away, brings it back.
  await page.getByRole('button', { name: 'Autopsy of crm_customers' }).click()
  await expect(page.getByRole('region', { name: 'Autopsy case file' })).toBeInViewport()
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await page.getByRole('button', { name: 'Autopsy of crm_customers' }).click()
  await expect(page.getByRole('region', { name: 'Autopsy case file' })).toBeInViewport()
})

for (const [label, width] of [['100% zoom', 1280], ['67% zoom', 1910]] as const) {
  test(`landing: START HERE sits above the button and the demo buttons share a baseline (${label})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    const business = page.getByRole('button', { name: 'Load business demo' })
    await expect(business).toBeVisible()
    const tag = page.getByText('Start here', { exact: true })
    const tagBox = (await tag.boundingBox())!
    const btnBox = (await business.boundingBox())!
    // Fully above the button's top edge (1px for the touching border).
    expect(tagBox.y + tagBox.height).toBeLessThanOrEqual(btnBox.y + 1.5)
    // Centered over the button.
    expect(Math.abs(tagBox.x + tagBox.width / 2 - (btnBox.x + btnBox.width / 2))).toBeLessThan(2)
    // All five demo buttons share one top edge when they fit on one row.
    const tops: number[] = []
    for (const name of ['Load business demo', 'Business: next month', 'Load demo data', 'Load mismatched demo', 'Lab: next month']) {
      tops.push((await page.getByRole('button', { name }).boundingBox())!.y)
    }
    if (width >= 1280) {
      for (const t of tops) expect(Math.abs(t - tops[0])).toBeLessThan(1)
    }
  })
}

test('Little Frank wakes with lightning and "IT\'S ALIVE!" when the business demo loads', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Load business demo' }).click()
  await expect(page.getByTestId('frank-lightning')).toBeAttached()
  await expect(page.locator('.specimen__bubble')).toHaveText("IT'S ALIVE!")
})

test('Ask Little Frank: the privacy answer shows, and Esc closes the guide', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Ask Little Frank' }).click()
  const dialog = page.getByRole('dialog', { name: 'Ask Little Frank' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox', { name: 'Your question' }).fill('is my data safe')
  await dialog.getByRole('button', { name: 'Ask', exact: true }).click()
  await expect(page.getByTestId('frank-answer')).toContainText('Your rows are never sent')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('reduced motion: no lightning element and no running Frank animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Load business demo' }).click()
  await expect(page.locator('.specimen__bubble')).toHaveText("IT'S ALIVE!")
  await expect(page.getByTestId('frank-lightning')).toHaveCount(0)
  const running = await page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => 'animationName' in a && String((a as CSSAnimation).animationName).startsWith('frank-'))
      .filter((a) => a.playState === 'running').length,
  )
  expect(running).toBe(0)
})

test('Frank effects never intercept a click: Stitch tables works while the wake plays', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Load business demo' }).click()
  await expect(page.getByTestId('frank-lightning')).toBeAttached()
  await page.getByRole('button', { name: 'Stitch tables' }).click({ timeout: 5000 })
  await expect(page.getByRole('button', { name: 'Approve all suggestions' })).toBeVisible()
})
