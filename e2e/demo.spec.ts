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
  await page.getByRole('button', { name: "Load next month's files" }).click()
  await expect(page.getByRole('region', { name: 'Preview of monsters', exact: true })).toBeVisible()
  await page.getByLabel('Apply recipe (JSON file)').setInputFiles(recipePath)
  await expect(page.getByText(/proposals? pre-approved/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Review in stitching table' }).click()
  await page.getByRole('button', { name: /Confirm & stitch/ }).click()
  await page.getByRole('button', { name: 'Apply & stitch' }).click()
  await expect(
    page.getByRole('region', { name: 'Stitched result preview' }).getByText('12 rows', { exact: true }),
  ).toBeVisible()
})
