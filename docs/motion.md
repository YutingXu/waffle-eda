# Motion rules

Every animation in Waffle follows these rules. They are based on Emil Kowalski's animation guidance,
adapted to Waffle: plain CSS and `element.animate()`, WKWebView, WebKitGTK and WebView2, and a canvas
you manipulate directly. Tokens and the Full / Reduced / Off levels are described in
[Design system › Motion](design-system.md#motion). Where that page and this one differ, this one wins.

There are two ways to get motion wrong, and the first is worse:

1. **Animating something that shouldn't move.** Deciding not to animate is a valid result.
2. **Animating the right thing badly:** ease-in on an entrance, growing from scale 0, keyframes on
   something you can trigger twice in a second, or a duration that makes a menu feel slow.

Decide, give the reason in one line, and build it. Don't offer motion options as a menu of choices.

## 1. Should it animate?

| How often | Decision |
|---|---|
| 100+ times a day, or started from the keyboard | **No animation.** Stop here. |
| Tens of times a day (hover, list navigation) | Barely noticeable (fast and subtle) or none |
| Occasional (dialogs, sheets, toasts) | Standard animation |
| Rare or first time (onboarding, a first export, a success) | Delight is allowed here only |

Anything started from the keyboard never animates. Raycast has no open or close animation, and that is
right for something opened hundreds of times a day.

## 2. What is it for?

Name the purpose before writing any code. It must be one of:

- **Feedback:** the interface heard you.
- **Spatial continuity:** where something came from or went.
- **State:** making a change of state readable.
- **Bridging:** content that would otherwise jump.
- **Explanation:** onboarding and the tutorial only.
- **Delight:** rare or first-time moments only.

If you can't name the purpose, don't build it. Never move data that someone is reading or acting on
for decoration.

## 3. Pick the cheapest tool that works

| Need | Tool |
|---|---|
| Hover, press, colour, or a state set by a class or attribute | CSS `transition` |
| An entrance on mount with no JS state | CSS `@starting-style` |
| Fixed motion that must stay smooth while the page is busy | CSS `animation` (runs off the main thread) |
| Motion controlled from code | `element.animate()` |
| The canvas camera, drags and gestures | `AtriumMotion.animate` (one shared `requestAnimationFrame` loop) |

No animation libraries and no React. `@starting-style` needs Safari 17.5 or later and WebKitGTK 2.44 or
later. Older Linux WebKitGTK versions show the entrance instantly, which is acceptable.

## 4. Which properties

- **Animate only `transform` and `opacity`.** Use `clip-path` for reveals. Height is allowed only for
  expanding and collapsing a section: use the `grid-template-rows: 0fr → 1fr` technique or FLIP.
  Never animate width, margin, padding, top or left.
- **Never start from `scale(0)`.** Start at 0.95–0.97 with opacity 0.
- **Popovers, menus and tooltips grow from their trigger** (`transform-origin` at the anchor).
  Dialogs stay centred.
- **Translate by percentages** of the element's own size, not fixed pixels.
- **Never drive children's transforms through a CSS variable on their parent.**

## 5. Easing, duration and springs

| Situation | Easing |
|---|---|
| Entering or leaving | ease-out |
| Moving on screen, the camera | ease-in-out |
| Hover, colour | `ease` |
| Constant motion (progress, ambient) | `linear` |

**Never use ease-in in the UI.** It starts slowly, at the moment the user is watching.

Target token values. Change the existing tokens; don't add a parallel set:

| Token | Value | Replaces |
|---|---|---|
| `--ease-decelerate` (ease-out) | `cubic-bezier(.23, 1, .32, 1)` | `cubic-bezier(.05,.7,.1,1)` |
| `--ease-standard` (ease-in-out) | `cubic-bezier(.77, 0, .175, 1)` | `cubic-bezier(.2,0,0,1)` |
| `--ease-accelerate` | alias of `--ease-decelerate` (exits use ease-out too) | `cubic-bezier(.3,0,.8,.15)` |
| `--ease-spring` | alias of `--ease-decelerate`: no overshoot in everyday UI | `cubic-bezier(.3,1.4,.5,1)` |
| `--ease-drawer` (new) | `cubic-bezier(.32, .72, 0, 1)` | for sheets and drawers only |

Any other curve must come from an established easing library, never a value made up because it looks
familiar.

| Element | Duration |
|---|---|
| Press feedback | 100–160 ms |
| Tooltips, small popovers | 125–200 ms |
| Menus, selects | 150–250 ms |
| Dialogs, sheets | 200–300 ms |
| Canvas camera flights | up to `--motion-slow` (320 ms), only for large moves |

**Interface animations stay under 300 ms.** Only the camera may go over that. The one other exception
(approved 2026-11-23) is a loading indicator: the library spinner (`.ui-spinner`) and the indeterminate
bar (`.ui-progress[data-indeterminate]`) loop until the wait ends. With Reduced motion they stay still,
and Off stops them.

**Springs** are for drags with momentum and for gestures someone can interrupt or reverse. Keep bounce
between 0.1 and 0.3, and only for drag-to-dismiss.

## 6. Interruption and exit

- **Use transitions, not keyframes, for anything that can fire twice in a second** (toggles,
  selection, toasts). Transitions continue from the current value; keyframes restart from zero.
- **Every animation can be interrupted.** It continues from where it is, never restarts and never
  queues.
- **Leave the way you came.** Something that rises in sinks out.
- **Faster on the way out** than on the way in.
- **Stagger groups by 30–80 ms** rather than bringing everything in at once.

## 7. Reduced motion and touch

These ship together with the animation, never later.

- **Reduced motion** keeps opacity and colour changes and drops movement and scale (`--motion-move` is
  0). It means gentler, not none.
- **Hover motion only for a real mouse:** wrap it in `@media (hover: hover) and (pointer: fine)`.
  Touchscreens fire hover on tap and leave it stuck.

## The canvas

The camera follows your hand directly. Pinch and trackpad scrolling are never smoothed. Mouse-wheel
notches glide to their target in about 120 ms with ease-out and add up when you scroll quickly.
Momentum panning stays on. Fit, Zoom to selection and cross-probe jumps fly with `--ease-standard`.
This keeps your view continuous; it isn't decoration.

## Waffle surfaces

| Surface | Tier | Purpose | Motion |
|---|---|---|---|
| Command palette and search, open, close, typing, selection | 100+/day, keyboard | — | **None** |
| Menus opened from the keyboard; moving across open menus | keyboard | — | **None** |
| Menus and context menus opened with the pointer | tens/day | spatial | 120 ms opacity + scale from 0.97 at the anchor, ease-out; close 80 ms |
| Tool switch, document tab switch, Save status, list arrow keys | 100+/day | — | **None** |
| Undo / redo | 100+/day, keyboard | state | Applies instantly; changed objects may show a highlight that fades over 200 ms and never blocks |
| Tooltips | tens/day | feedback | 500 ms first delay, then instant for neighbours within 1 s; 125 ms fade |
| Hover cards (ports, nets) | tens/day | spatial | 300 ms intent delay; 150 ms opacity + 2 px, ease-out; placed so they never cover the object |
| Sections, panels, tree folders | tens/day | bridging | 200 ms height (grid rows) + fade, ease-out; chevron turns with it |
| Panel tab indicator | tens/day | spatial | Slides 200 ms ease-in-out; content changes instantly |
| Document tabs: open, close, drag to reorder | occasional | spatial | Grow or collapse 150 ms; neighbours slide 180 ms (FLIP) |
| Lists: insert, remove, reorder | occasional | bridging | FLIP 180 ms ease-out, staggered 30 ms |
| Dialogs, sheets, settings window | occasional | spatial | 200 ms opacity + scale from 0.97, ease-out; exit 150 ms |
| Toasts | occasional | state | Transition (not keyframes) in from the bottom; out the same way |
| Switches | tens/day | state | Knob 200 ms ease-out, no overshoot |
| Theme switch | rare | bridging | 200 ms crossfade |
| Drag and drop | occasional | feedback | Lift 120 ms (scale 1.02 + shadow); target highlights in 100 ms; a cancel returns in 200 ms ease-out |
| First project, first export, tutorial | rare | delight, explanation | Longer motion is allowed |

## Never ship

| Never | Instead |
|---|---|
| `transition: all` | Name the properties |
| Entrance from `scale(0)` | `scale(.95–.97)` + opacity 0 |
| ease-in on UI, or the built-in `ease-out` on deliberate motion | `--ease-decelerate` |
| Animation on a keyboard shortcut or a 100+/day action | None |
| UI duration over 300 ms without a reason | 150–250 ms |
| Popover growing from its centre | Grow from the trigger |
| Keyframes on toggles, toasts or anything repeatable | Transitions |
| Animating width, height (except sections), margin, padding, top or left | `transform`, `opacity` |
| Hover motion without the pointer media query | `@media (hover: hover) and (pointer: fine)` |
| No reduced-motion version | Gentler version, not none |
| Everything entering at once | 30–80 ms stagger |

## Checking

`tests/editor/motion.cjs` enforces the tokens and these rules across `app/**/*.css`:

- no `transition: all`;
- no `scale(0)`;
- no ease-in curves;
- every UI duration under 300 ms (camera tokens and the library's looping loaders excepted);
- nothing loops except `.ui-spinner` and `.ui-progress[data-indeterminate]` in `ui/components.css`,
  and each of those has a still path for both Reduced and the system setting;
- every `:hover` rule that changes a transform sits inside the pointer media query;
- a reduced-motion path for every keyframe that moves something.

Feel can't be judged from code. Before review, record each surface on the 120 Hz MacBook, play it at
2–5× slower in the animation inspector, and look again the next day.
