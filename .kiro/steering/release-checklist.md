---
inclusion: manual
---
# Release checklist

Use this before merging a feature branch and before deploying. Include it in chat with `#release-checklist`.

## Before merging

1. Work on a feature branch, not `main`. Confirm with `git branch --show-current`.
2. `git status` is clean or only has intended changes. No `.env`, no `frankendata-output`, no `mcp/dist` or `dist`.
3. Run the full gate, all must pass:
   - `npm test`
   - `npm run build`
   - `npm run lint` (warnings from the existing pattern are accepted, errors are not)
   - `npm run check:api`
   - `npm run mcp:build`
4. Browser click-through of the demo with `npm run dev`:
   - Click "Load mismatched demo", open the stitching table, approve all suggestions, "Confirm & stitch", "Apply & stitch". Expect 12 rows.
   - Click the species starter chip in Ask the Lab. Expect Swamp Wraith with 3.
   - Open the Autopsy on monsters. Expect score 81.
   - "Save recipe", "Reset lab", "Load next month's files", "Apply recipe", "Review in stitching table", confirm and apply. Expect 12 rows.
   - Check nothing scrolls on its own, and that the console shows no errors.
5. If anything under `mcp/` changed, reconnect the server in Kiro and call one tool.
6. Read the diff for secrets, new network calls, and changes to `api/`, the SQL validator or the path guard.

## Merge

7. Merge into `main` locally (`git checkout main`, `git pull`, `git merge <branch>`), then re-run `npm test` and `npm run build` on `main`.

## Deploy

8. Push `main`. Vercel builds from the push. Confirm the Vercel environment variables are set (`VITE_AI_ENABLED`, `AI_PROVIDER`, `AI_MODEL`, `OPENAI_API_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `IP_HASH_SALT`) as described in `DEPLOY.md`.
9. Live check on the deployed URL: load the demo, stitch, query, Autopsy, recipe. With AI off the app must work fully offline on the rules engine.
10. If the live check fails, roll back by redeploying the previous Vercel deployment and open a fix branch.
