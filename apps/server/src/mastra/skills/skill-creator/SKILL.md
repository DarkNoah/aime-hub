---
name: skill-creator
description: Create or update reusable skills with focused instructions and supporting scripts, references, or assets. Use when the user wants to turn a workflow into a skill or improve an existing skill in the current personal or project scope.
metadata:
  short-description: Create or improve a skill in the current scope
---

<!-- Adapted from the bundled skill-creation guide. Modified to remove product-specific metadata and use the current workspace scope. See license.txt. -->

# Skill Creator

Create skills that provide useful, non-obvious guidance while preserving the user's intent and task boundaries.

## Core Principles

- **Assume the agent is capable.** Include information that changes decisions or improves results. Remove generic advice, repeated instructions, speculative edge cases, and examples that do not clarify the task.
- **Preserve intent and scope.** A skill supports the requested work; it does not replace the user's chosen tools, expand the assignment, modify unrelated configuration, or authorize additional external actions. Do not turn one past failure or preference into a universal rule.
- **Match specificity to the task.** Describe outcomes and decision criteria for open-ended work. Use deterministic scripts or strict sequences when deviation would cause a concrete correctness, safety, or permission problem. Distinguish requirements from recommendations.
- **Keep discovery precise.** The name and description should explain what the skill does and when it applies. Add exclusions only when they prevent likely confusion with another capability.
- **Keep resources self-contained.** Reference other tools or skills only when the workflow needs them and they are available in the target environment. Do not assume a particular model, provider, desktop application, or tool name.
- **Disclose detail progressively.** Put shared purpose, essential constraints, and routing in `SKILL.md`; place substantial conditional detail in supporting references. A short skill does not need extra directories or a routing layer.

## Skill Location

Follow the same scope rules as skill installation. The runtime supplies the current installation root through the absolute `SKILL_HOME` environment variable:

| Context       | Skill root                                           |
| ------------- | ---------------------------------------------------- |
| Personal chat | `WORKSPACE_ROOT/users/<userId>/.agents/skills`       |
| Project chat  | `WORKSPACE_ROOT/projects/<projectId>/.agents/skills` |

Use the actual `SKILL_HOME` value. If it is missing or not absolute, stop writing and explain that the runtime has not supplied a valid location. Do not infer an account, project, operating-system home, current working directory, or personal session's dated directory. Do not change `SKILL_HOME` to write into another scope.

Create authored skills at `$SKILL_HOME/<skill-name>/SKILL.md`. Repository-installed skills may already reside at `$SKILL_HOME/<owner>/<repo>/<skill-name>/SKILL.md`; update the requested package in place and preserve its supporting files and `.skill-sources.json` records. Explain that a later repository update may replace local edits when that is relevant to the request.

Global skills reside in `WORKSPACE_ROOT/.agents/skills` and are maintained through the management interface. Personal and project skills override global skills with the same directory name; project chats do not inherit personal skills. Do not edit the global `builtin` directory through this workflow. If the user wants a scoped adaptation of a global skill, create it under the current `SKILL_HOME` and report that scope explicitly.

## Anatomy of a Skill

```text
skill-name/
|-- SKILL.md       Required manifest and instructions
|-- scripts/       Optional executable helpers
|-- references/    Optional details loaded when needed
`-- assets/        Optional templates or files used in output
```

`SKILL.md` starts with YAML frontmatter containing `name` and `description`. Preserve supported optional fields, such as `metadata`, when updating an existing skill. Add runtime-specific metadata only when the target environment supports it and the task requires it; do not generate product-specific interface files by default.

The name and description are available during selection; the body is loaded when the skill is used; supporting resources are read or executed only when needed. Keep the entrypoint as short as the task permits without removing important constraints.

- Use **scripts** for repeated transformations or fragile operations that benefit from deterministic execution. Run new or changed scripts to verify their behavior, and declare their dependencies.
- Use **references** for maintained schemas, procedures, or mode-specific examples. Link each reference where it becomes relevant and explain when to read it. Avoid duplicating reference content in the entrypoint or loading every reference by default.
- Use **assets** for templates, images, fonts, or starter files that belong in the output. They are not instructions unless the task requires inspecting them.

Create only files that support the skill's work. Avoid empty placeholders, copied manuals, changelogs, duplicated quick references, or additional installation guides without a concrete need. Preserve required license and attribution notices when adapting existing material.

## Create or Update a Skill

### Understand the Intended Use

Use the user's request and available context to identify the outcome, likely triggering requests, and reusable resources. Ask only when missing information materially affects the result and cannot be inferred. A clear request does not need additional example collection or a fixed planning ceremony.

Inspect an existing skill before editing it. Preserve its useful constraints, resources, supported metadata, and invocation settings unless the requested change calls for replacing them. Do not infer an explicit-only invocation policy merely because the workflow includes sensitive operations; require any necessary authorization at the actual operation.

### Choose a Name and Initialize

Use 1-64 characters consisting of lowercase letters, digits, and single hyphens. Avoid leading, trailing, or consecutive hyphens. Prefer a short action-oriented name, adding a tool or domain qualifier only when it improves discovery. The directory name must match the manifest name.

The runtime injects `BUILTIN_SKILLS_ROOT`, the absolute `<WORKSPACE_ROOT>/.agents/skills/builtin` directory. Use the quoted script paths below from any working directory. Shell sessions continued with `write_stdin` retain these environment variables from `exec_command`. Python 3.10 or later is required.

```sh
python3 "$BUILTIN_SKILLS_ROOT/skill-creator/scripts/init_skill.py" my-skill
python3 "$BUILTIN_SKILLS_ROOT/skill-creator/scripts/init_skill.py" another-skill --path "$SKILL_HOME" --resources scripts,references
```

Replace the example names with the intended name. The initializer uses `SKILL_HOME`; optional `--path` must match it. It creates a `SKILL.md` starter and only the resource directories requested. It refuses existing destinations, so update existing skills directly instead of initializing them again. Do not delete an existing skill to bypass a collision.

Complete the starter's description and instructions before delivery. Add supporting resources only when they have a clear use. The initializer deliberately leaves unfinished placeholders that the validator will reject.

### Write the Instructions

The frontmatter description should briefly explain the capability and when to use it. For example:

```yaml
name: document-review
description: Review document drafts for consistency with a supplied style guide. Use when the user requests an editorial review against explicit writing rules.
```

Keep detailed steps, tool choices, and mode-specific examples in the body or linked references. Write the guidance another agent needs to complete the task well: desired outcomes, non-obvious context, real constraints, and relevant resources. Preserve existing authorization boundaries without inventing approval steps for routine work that the user already requested.

For multiple substantial modes, put selection criteria in the entrypoint and link only the relevant reference. For example, an ordinary document-editing workflow may link to `references/redlining.md` only for tracked changes. Avoid a fixed file structure or number of steps when the task does not require one.

### Validate and Iterate

Run the bundled validator on the completed directory:

```sh
python3 "$BUILTIN_SKILLS_ROOT/skill-creator/scripts/quick_validate.py" "$SKILL_HOME/my-skill"
```

Validation requires the YAML parser declared in `$BUILTIN_SKILLS_ROOT/skill-creator/scripts/requirements.txt`. If it is missing, use an available Python environment with that dependency or install it into a permitted virtual environment:

```sh
python3 -m pip install -r "$BUILTIN_SKILLS_ROOT/skill-creator/scripts/requirements.txt"
```

Do not claim validation passed if a dependency prevented it from running. The initializer itself uses only the standard library.

The validator checks the frontmatter, required fields, directory-name consistency, and unfinished instruction placeholders. It does not prove that linked resources exist, scripts work, runtime-specific fields are supported, or the instructions produce good decisions. Check those separately where relevant:

1. Read the description and confirm it selects the intended requests without attracting unrelated work.
2. Verify referenced paths exist and scripts run with realistic inputs and declared dependencies.
3. Check that the workflow respects the requested scope and does not alter unrelated files or configuration.
4. When complexity warrants behavioral testing, exercise a realistic request in an isolated temporary workspace and inspect the resulting artifacts. Use delegation only when available and authorized; a small skill does not require a separate evaluator.

Prefer meaningful behavior checks over tests that merely match wording or headings. Improve instructions in response to observed failures rather than accumulating speculative rules.

Report the final skill path, its personal or project scope, the resources included, and checks actually performed. Saving a skill and loading it into an active agent are separate events; do not promise automatic loading on the next turn or require restarting the entire service.
