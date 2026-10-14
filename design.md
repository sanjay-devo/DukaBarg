# InApp Inventory Dashboard

## Mission
Create implementation-ready, token-driven UI guidance for InApp Inventory Dashboard that is optimized for consistency, accessibility, and fast delivery across dashboard web app.

## Brand
- Product/brand: InApp Inventory Dashboard
- Audience: authenticated users and operators
- Product surface: dashboard web app

## Style Foundations
- Visual style: structured, tokenized, content-first
- Main font style: `font.family.primary=Poppins`, `font.family.stack=Poppins, sans-serif`, `font.size.base=14px`, `font.weight.base=400`, `font.lineHeight.base=21px`
- Typography scale: `font.size.xs=11.9px`, `font.size.sm=12.25px`, `font.size.md=14px`, `font.size.lg=17.5px`, `font.size.xl=21px`, `font.size.2xl=24.5px`, `font.size.3xl=28px`, `font.size.4xl=35px`
- Color palette: `color.text.primary=#171717`, `color.border.strong=#e66239`, `color.text.tertiary=#262626`, `color.text.inverse=#525252`, `color.surface.base=#000000`, `color.surface.muted=#ffffff`, `color.surface.raised=#f5f5f5`, `color.border.muted=#e5e5e5`
- Spacing scale: `space.1=1px`, `space.2=4px`, `space.3=8px`, `space.4=10px`, `space.5=12px`, `space.6=16px`, `space.7=24px`, `space.8=40px`
- Radius/shadow/motion tokens: `radius.xs=4px`, `radius.sm=5px`, `radius.md=6px`, `radius.lg=8px`, `radius.xl=50px` | `motion.duration.instant=150ms`, `motion.duration.fast=300ms`

## Accessibility
- Target: WCAG 2.2 AA
- Keyboard-first interactions required.
- Focus-visible rules required.
- Contrast constraints required.

## Writing Tone
Concise, confident, implementation-focused.

## Rules: Do
- Use semantic tokens, not raw hex values, in component guidance.
- Every component must define states for default, hover, focus-visible, active, disabled, loading, and error.
- Component behavior should specify responsive and edge-case handling.
- Interactive components must document keyboard, pointer, and touch behavior.
- Accessibility acceptance criteria must be testable in implementation.

## Rules: Don't
- Do not allow low-contrast text or hidden focus indicators.
- Do not introduce one-off spacing or typography exceptions.
- Do not use ambiguous labels or non-descriptive actions.
- Do not ship component guidance without explicit state rules.

## Guideline Authoring Workflow
1. Restate design intent in one sentence.
2. Define foundations and semantic tokens.
3. Define component anatomy, variants, interactions, and state behavior.
4. Add accessibility acceptance criteria with pass/fail checks.
5. Add anti-patterns, migration notes, and edge-case handling.
6. End with a QA checklist.

## Required Output Structure
- Context and goals.
- Design tokens and foundations.
- Component-level rules (anatomy, variants, states, responsive behavior).
- Accessibility requirements and testable acceptance criteria.
- Content and tone standards with examples.
- Anti-patterns and prohibited implementations.
- QA checklist.

## Component Rule Expectations
- Include keyboard, pointer, and touch behavior.
- Include spacing and typography token requirements.
- Include long-content, overflow, and empty-state handling.
- Include known page component density: links (23), cards (23), buttons (6), lists (6), inputs (2), navigation (1).

- Extraction diagnostics: Audience and product surface inference confidence is low; verify generated brand context.

## Quality Gates
- Every non-negotiable rule must use "must".
- Every recommendation should use "should".
- Every accessibility rule must be testable in implementation.
- Teams should prefer system consistency over local visual exceptions.
