Who I Am
I'm a solo developer (newbie at vibe coding). I use Claude Code to build projects iteratively. I have limited git proficiency — never ask me to rebase, cherry-pick, or resolve merge conflicts.

Communication Rules
Be Concise

No narration. Don't say "Let me check...", "Now I'll...", "Let me update the plan...". Just do the work and report the result.
No restating what I said. If I give you a spec, don't echo it back to me.
No status tables unless I ask. A one-liner like "✅ Step 1 done — repo created, Supabase linked, env vars set" is enough.
Combine checks. Run node --version && npm --version && which gh && which supabase && which vercel in ONE command, not five.

Don't Over-Plan

Don't create/update a "plan" unless I ask for one.
Don't ask me questions you can answer yourself (e.g., "is Node installed?" — just check).
If a step has sub-steps, just execute them. Don't list them first, then ask permission, then execute.


Token & Context Efficiency
The #1 Rule: Files Over Context

Specs, schemas, and detailed requirements go in files (SPEC.md, TODO.md, SCHEMA.sql), not in conversation context.
When you need info from a spec file, read only the relevant section — don't load the whole file if you only need the DB schema.
If I paste a long spec inline, your FIRST action should be to save it to a file, then work from the file.

Use Subagents to Keep the Main Context Clean
Subagents (via Task(...)) run in their own context window — when they finish, only their short summary enters the main conversation. Use them aggressively for read-heavy or research-heavy work that would otherwise bloat the main context.
ALWAYS use a subagent for:

Session startup: Gathering current state from TODO.md, SPEC.md, and recent git log. The subagent reads all files and returns a brief status summary (what's done, what's next, any blockers). The main agent never reads these files directly at session start.
Spec lookups: When you need details from SPEC.md for a specific task (e.g., "what's the DB schema for the settings table?"), send a subagent to read the relevant section and return only the needed info.
Code review / audit: "Read all files in src/ and list any TODO comments" or "check which API routes are implemented vs. what SPEC.md requires."
Debugging investigation: "Read the error log, check the relevant source files, and summarize what's wrong and where."
Dependency/config checks: "Check package.json, tsconfig, vite.config, and tailwind.config — summarize what's set up and what's missing for the next step."

Subagent prompt template:
Task("Read TODO.md and SPEC.md. Return:
1. Last completed step (the last [x] item)
2. Next uncompleted step (the first [ ] item)  
3. Only the SPEC.md section relevant to that next step (summarized in ≤10 lines)
4. Any blockers or env vars needed")
Do NOT use subagents for:

Simple single-file edits (just do them directly)
Running a single CLI command
Anything where the result needs to be shown to me verbatim (e.g., I ask "show me the current schema")

Don't Repeat Yourself

Never regenerate or rewrite content that already exists in a file.
If a TODO.md exists, update specific lines — don't rewrite the whole file.
If you wrote a migration file, don't also print the full SQL in your response.

Fail Fast on CLI Commands

If a CLI command fails twice with different syntax, STOP and ask me.
Don't try 5+ variations of vercel env add — after 2 failures, tell me the issue and ask how I want to handle it (manual? different approach?).
Before running a CLI command with complex flags, check --help first (one command) rather than guessing syntax.

Batch Operations

Set multiple env vars in a loop or script, not one-at-a-time interactive commands.
Run related checks in a single bash call.
When creating multiple files, use a setup script if >3 files.


CLI Tools

Supabase CLI → always use npx supabase (not a global install).
Vercel CLI → always use npx vercel (not a global install).


Git Workflow

Direct to main branch. No feature branches unless I ask.
Commit after each meaningful unit of work (not after every single file).
Commit messages: short, descriptive (e.g., "add Supabase schema + migration").
Never ask me to rebase, cherry-pick, or resolve conflicts. Fix it yourself or ask me what to keep.


Project Structure Conventions

Keep a TODO.md with checkbox items - [ ] / - [x] for build steps.
Keep a SPEC.md for the full project specification.
Update TODO.md as steps are completed (mark [x], don't delete).
When starting a new chat session, read TODO.md first to know where we left off.


When Starting a New Session

Read CLAUDE.md (this file) — this is the only file the main agent reads directly.
Use a subagent to gather current state:

   Task("Read TODO.md, SPEC.md, and run `git log --oneline -5`. Return:
   1. Last completed step
   2. Next step to work on
   3. Summary of the relevant SPEC.md section for that step (≤10 lines)
   4. Any blockers, missing env vars, or incomplete migrations")

Resume work based on the subagent's summary — don't ask "where did we leave off?"


Error Handling

If a build/deploy fails, show me only the relevant error lines, not the full output.
Propose a fix, don't just report the error.
If you're unsure about the fix, say so and give me 2 options max.


Autonomy — What You Can Do Without Asking
Once I approve a task or step, you have blanket permission for everything needed to complete it. Don't stop mid-task to ask "can I read this file?" or "should I commit now?"
Never ask permission for:

Reading, viewing, or searching any file in the project
Creating or editing source files, configs, migrations
Running git add, git commit, git push
Installing npm/pip dependencies
Running linters, formatters, type-checks, or tests
Creating directories
Running build commands

Ask permission ONLY for:

Deleting files or data (destructive actions)
Changing env vars or secrets
Running interactive CLI commands that need my input (e.g., supabase login)
Deploying to production (npx vercel --prod)
Anything that costs money (e.g., provisioning a paid resource)

The principle: If I said "build the LogTab component," that means do everything — write the code, create the files, install deps if needed, commit, push. Don't pause to ask me if you can read SPEC.md or commit to git. I won't be reviewing code to approve commits anyway.

What NOT to Do

Don't create "plans" with nested sub-steps that you then ask me to approve before doing anything.
Don't update the plan file after every minor discovery (e.g., "CLI is already installed").
Don't echo secrets/keys back in your responses.
Don't try parallel tool calls for operations that depend on each other.
