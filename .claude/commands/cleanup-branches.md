Find and clean up stale git branches (local and remote).

Steps:
1. Run `git fetch --prune`
2. List all local branches with their remote tracking status, last commit date, and merge status relative to main
3. Categorize branches:
   - **Merged**: fully merged into main — safe to delete
   - **Gone**: remote deleted but local still exists — likely safe to delete
   - **Stale**: not merged, last commit older than 4 weeks — review before deleting
4. Present the categorized list to the user and ask which ones to delete
5. For approved branches, delete both local and remote (if remote exists):
   - `git branch -d <branch>` for merged branches
   - `git branch -D <branch>` for unmerged branches
   - `git push origin --delete <branch>` for remote branches
6. Report what was cleaned up
