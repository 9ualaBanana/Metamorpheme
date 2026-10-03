# Animation clock

Every morph plays on the window that contains its element at the moment a timer is scheduled. Editor, reading view, note titles, and the settings preview all use `createMorph`. They do not get a separate clock.

## Principle

1. Read `element.ownerDocument.defaultView` when scheduling, and again for every later frame. Do not keep a `Window` taken while the element was still being built.
2. `createMorph` builds the element in the editor window. The caller appends it afterwards. The settings tab appends it into the settings window. Work scheduled during construction waits one microtask, then reads the window again.
3. Timeouts, animation frames, and `IntersectionObserver` for a morph go through `src/animation-clock.ts` only: `requestElementTimeout`, `requestElementFrame`, `watchElementVisibility`, `whenAttached`.
4. Do not spin `queueMicrotask` until `isConnected`. That never yields and freezes note open. After the one microtask, wait on frames of the element's current window, at most eight, then stop. `show` and `refresh` may schedule again.
5. The settings preview must keep morphing while the editor window is covered. Chromium does not deliver frames for a covered window. A clock captured from the editor fails this check.

A title rescan (`scanTitles`) is not a morph timer. It may use the editor window. Playback inside a title morph still follows this spec.

The file explorer often inserts a title morph before that pane has a box (sidebar hidden, folder collapsed, list not laid out). The first visibility report is then hidden. A later show does not always produce a second report, so playback stays stopped while the inline title and the tab title, already on screen, keep playing. Re-arm with `watchElementVisibility` through `syncVisibility` when the explorer updates and, while playback is paused, on the title rescan. That reads the element's window again. It does not add a second clock.

Graph and local graph are deferred views: the leaf and its renderer exist only after the view is opened. A metamorpheme in a graph title uses the same player as a note morph. Time is scheduled on the graph canvas through `morphClock`. Each frame is applied at the end of the node's own `render`, after the graph has written that label's position, scale, and alpha. `renderer.changed()` only wakes the graph's existing draw. Do not place a second title, and do not drive the graph from a `Window` captured in the editor.
