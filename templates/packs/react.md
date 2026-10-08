---
id: react
title: React
---

## @pm
- Specify loading, empty, error and success states for every view that fetches data, plus the disabled state of buttons during submission.
- Specify keyboard and screen-reader behavior for new interactive elements (labels, focus order, focus after dialogs close).

## @developer
- Follow the project's existing data-fetching approach (React Query, SWR, custom hooks, Redux…) rather than introducing another.
- Disable submit buttons while a request is in flight to prevent double submission; handle request errors visibly.
- Keys in lists must be stable ids, not array indexes, when items can be reordered or removed.
- Derive state instead of duplicating it; avoid effects that only sync one state to another.
- Use semantic elements (`button`, `label`, `form`) and associate labels with inputs.

## @qa
- If the project has React Testing Library, test behavior through what the user sees and does (`getByRole`, `userEvent`), not implementation details.
- Check: double clicks, slow or failing network (loading and error states), empty data, very long text, narrow screens, refresh in the middle of a flow, back navigation.

## @security
- `dangerouslySetInnerHTML`, `href={userInput}` (`javascript:` URLs) and injecting user content into `<script>` or styles are XSS vectors.
- Secrets in frontend code or `REACT_APP_*` / `VITE_*` env variables are public.
- Authorization enforced only in the UI is not authorization; the API must enforce it.

## @reviewer
- Missing dependency arrays or stale closures in `useEffect`; effects without cleanup for subscriptions and timers.
- Components doing data fetching, business logic and rendering at once when the project separates them.
