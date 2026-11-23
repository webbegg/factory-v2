import { describe, expect, test } from 'bun:test'
import { bashRefusal, toolRefusal } from './agents/runner'

const BRANCH = 'factory/001-x'
const builder = (cmd: string) => bashRefusal(cmd, 'builder', BRANCH)
const reviewer = (cmd: string) => bashRefusal(cmd, 'reviewer-code', BRANCH)

describe('bashRefusal', () => {
  test('the builder pushes its own branch, and nothing else', () => {
    for (const ok of [
      'git push -u origin factory/001-x', 'cd /w && git push -q -u origin HEAD:factory/001-x',
      'git push origin HEAD:factory/001-x', 'git status && git log --oneline origin/main..HEAD'
    ]) expect(builder(ok)).toBeNull()
    for (const bad of [
      'git push origin master', 'git push origin HEAD:master', 'git push --force', 'git push -f origin factory/001-x',
      'git push --force-with-lease', 'git push origin +factory/001-x', 'git push origin --delete factory/002-y',
      'git push origin :factory/001-x', 'git push --all', 'git push --mirror', 'git push https://x/y.git factory/001-x',
      'git -C /repo push origin main', 'cd /w; git push origin main', 'bash -c "git push origin main"',
      // HEAD is whatever branch is checked out, so it must be named
      'git push origin HEAD'
    ]) expect(builder(bad)).toMatch(/may not|only/)
  })

  test('the builder stays on its branch', () => {
    for (const bad of ['git checkout -B main origin/main', 'git checkout -b other', 'git switch main', 'git branch -u origin/main', 'git branch -f main HEAD', 'git checkout --detach']) {
      expect(builder(bad)).toMatch(/stays on/)
    }
    expect(builder('git checkout -- src/a.ts')).toBeNull()
  })

  test('nobody merges, readies, closes or approves PRs, or writes to GitHub through gh api', () => {
    for (const bad of [
      'gh pr merge 9 --squash', 'gh pr ready 9', 'gh pr close 9', 'gh pr review 9 --approve', 'gh pr checkout 9',
      'gh api -X POST repos/o/r/pulls/9/merge', 'gh api --method=PUT repos/o/r/pulls/9/merge',
      'gh api repos/o/r/issues/1/labels -f labels=factory', 'gh api graphql -F query=@m.graphql',
      'gh issue edit 1 --add-label factory', 'gh label create x', 'gh workflow run ci', 'gh auth token',
      'gh secret list', 'gh repo delete o/r', 'gh alias set m "pr merge"'
    ]) {
      expect(builder(bad)).not.toBeNull()
      expect(reviewer(bad)).not.toBeNull()
    }
    for (const ok of ['gh pr view factory/001-x', 'gh pr diff 9', 'gh pr checks 9', 'gh api repos/o/r/pulls/9', 'gh issue view 1', 'gh auth status']) {
      expect(reviewer(ok)).toBeNull()
    }
  })

  test('the builder opens and edits its draft PR; read-only agents can\'t', () => {
    const create = 'gh pr create --draft --base main --head factory/001-x --title T --body "Closes #1"'
    expect(builder(create)).toBeNull()
    expect(builder('gh pr edit 9 --body x')).toBeNull()
    expect(reviewer(create)).not.toBeNull()
    expect(bashRefusal('gh pr comment 9 --body x', 'approver', BRANCH)).not.toBeNull()
  })

  test('read-only agents can look at git but not change it', () => {
    for (const ok of ['git log --oneline origin/main..HEAD', 'git diff origin/main...HEAD', 'git show HEAD:a.ts', 'git branch --show-current', 'git status --porcelain', 'git fetch -q origin main']) {
      expect(reviewer(ok)).toBeNull()
    }
    for (const bad of ['git commit -qm x', 'git checkout main', 'git reset --hard HEAD~1', 'git stash', 'git branch -D x', 'git branch new', 'git merge origin/main', 'git worktree remove /w', 'git tag v1']) {
      expect(reviewer(bad)).toMatch(/reviewer-code may not run git/)
    }
    expect(builder('git commit -qm x')).toBeNull()
  })

  test('nobody rewires git with config or aliases', () => {
    expect(builder('git config alias.p "push --force"')).not.toBeNull()
    expect(builder('git -c alias.p="push --force" p')).not.toBeNull()
    expect(builder('git config --get user.email')).toBeNull()
  })
})

describe('bashRefusal against shell spellings (verify B1, B2)', () => {
  test('quotes, backslashes and variable command names don\'t hide git or gh', () => {
    for (const bad of [
      'g\'\'it push origin HEAD:main', 'g"i"t push origin HEAD:main', '\\gh pr merge 5 --merge', '\\git push origin main',
      'G=git; $G push origin main', '$\'\\x67it\' push origin main', 'eval "gh pr merge 5"'
    ]) {
      expect(builder(bad)).not.toBeNull()
      expect(reviewer(bad)).not.toBeNull()
    }
  })

  test('attached and bundled flag forms', () => {
    for (const bad of ['gh api -XPUT repos/o/r/pulls/5/merge', 'gh api graphql -fquery=mutation', 'gh api x -Fa=1', 'gh api x --field=a=1', 'gh api x --input=f.json']) {
      expect(reviewer(bad)).not.toBeNull()
    }
    for (const bad of ['git push -uf origin factory/001-x', 'git push -fu origin factory/001-x', 'git push -qd origin factory/001-x']) {
      expect(builder(bad)).not.toBeNull()
    }
  })

  test('the builder names its branch on every push, and can\'t rewrite refs or remotes', () => {
    for (const bad of [
      'git push', 'git push origin', 'git checkout --ignore-other-worktrees main && git push -q origin',
      'git -c remote.origin.push=+HEAD:refs/heads/main push origin', 'git -c remote.origin.mirror=true push origin factory/001-x',
      'git -c Alias.m=x m', 'git --config-env=alias.m=X m', 'git update-ref refs/remotes/origin/main abc',
      'git symbolic-ref HEAD refs/heads/main', 'git remote set-url origin https://evil/x.git', 'git replace a b',
      'git fetch origin factory/001-x:refs/remotes/origin/main'
    ]) expect(builder(bad)).not.toBeNull()
    expect(builder('git remote -v')).toBeNull()
    expect(builder('git fetch -q origin main')).toBeNull()
  })

  test('read-only agents get an allowlist of git reads', () => {
    for (const bad of ['git update-index --assume-unchanged a', 'git notes add -m x', 'git hash-object -w a', 'git reflog expire --all', 'git remote set-url origin x', 'git fetch origin a:refs/heads/b']) {
      expect(reviewer(bad)).not.toBeNull()
    }
    for (const ok of ['git rev-parse HEAD', 'git ls-files', 'git blame a.ts', 'git merge-base HEAD origin/main', 'git remote -v']) {
      expect(reviewer(ok)).toBeNull()
    }
  })
})

describe('bashRefusal recheck (verify run 2)', () => {
  test('quoted separators, line continuations and quoted commands are read as the shell reads them', () => {
    for (const bad of [
      'git push -q origin factory/001-x --repo=";" HEAD:main', 'gi\\\nt push -q origin HEAD:main',
      'bash -c "git push origin HEAD:main"', 'G=git bash -c \'$G push origin HEAD:main\'', 'G=git; env $G push origin HEAD:main',
      'x=$(echo Z2g= | base64 -d); command eval $x', 'git${IFS}push${IFS}origin${IFS}HEAD:main', '{git,push,origin,HEAD:main}',
      '/usr/bin/gi? push origin HEAD:main'
    ]) expect(builder(bad)).not.toBeNull()
    expect(builder('git commit -qm "fix: a; b && c"')).toBeNull()
    expect(builder('cd $(git rev-parse --show-toplevel) && git status')).toBeNull()
  })

  test('git config through the environment is refused', () => {
    expect(builder('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=x git p')).not.toBeNull()
    expect(builder('export GIT_CONFIG_PARAMETERS=x; git push -u origin factory/001-x')).not.toBeNull()
  })

  test('bundled gh api flags and git push plumbing', () => {
    expect(reviewer('gh api -iXPUT repos/o/r/pulls/5/merge')).not.toBeNull()
    expect(reviewer('gh api -iX PUT repos/o/r/pulls/5/merge')).not.toBeNull()
    expect(reviewer('gh api -iflabels=x repos/o/r/issues/1/labels')).not.toBeNull()
    expect(reviewer('gh api -i repos/o/r/pulls/5')).toBeNull()
    for (const bad of ['git send-pack ../origin.git HEAD:refs/heads/main', 'git subtree push --prefix=x origin main', 'git http-push x']) {
      expect(builder(bad)).not.toBeNull()
    }
  })
})

describe('toolRefusal', () => {
  const task = { agent: 'reviewer-code' as const, branch: BRANCH, writable: ['/jobs/1/round-1/review-code.md'] }

  test('Bash goes through the command guard, Write and Edit through the writable list', () => {
    expect(toolRefusal('Bash', { command: 'gh pr merge 9' }, task)).toContain('gh pr merge')
    expect(toolRefusal('Bash', { command: 'git log' }, task)).toBeNull()
    expect(toolRefusal('Write', { file_path: '/jobs/1/decision.md' }, task)).toContain('only lets reviewer-code write')
    expect(toolRefusal('Write', { file_path: '/jobs/1/round-1/review-code.md' }, task)).toBeNull()
    expect(toolRefusal('Read', { file_path: '/anything' }, task)).toBeNull()
  })
})
