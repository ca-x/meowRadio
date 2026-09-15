# meowRadio receiver
The UI/UX search matched Skeuomorphism (styles.csv). The aggregate marketing/Swiss result was not appropriate and is not used.
Walnut enclosure, warm aluminum panel, inset amber LCD, woven speaker grille. Background #eeeae3, foreground #302e29, secondary text #686258, action #a6452c, display #edcf88 on #292a23. System sans serif and monospace display fonts: offline, no font requests.
Use Radix Dialog for focus management. Buttons >=44px, visible keyboard focus, labels for every control. Press feedback scale .97 for 120ms cubic-bezier(.23,1,.32,1); keyboard and reduced-motion interactions have no motion. No decorative perpetual animation or fake equalizer. Real playback state controls the on-air indicator. Station ticks are indices, never simulated MHz.

## Additional user-specified themes
Vitreous: cyan/violet ambient light, glass panel, Outfit and Space Mono bundled locally, circular play key. LED: scoped 9×9×3 CSS cube, cyan/magenta/ice faces, 2D/3D controls, bounded stage/floor light. Both preserve the existing audio element and real playback state. Decorative visuals stop when paused or under reduced motion; controls remain keyboard operable. Theme/view preferences live in localStorage.
