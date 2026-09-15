# meowRadio receiver
The UI/UX search matched Skeuomorphism (styles.csv). The aggregate marketing/Swiss result was not appropriate and is not used.
Walnut enclosure, warm aluminum panel, inset amber LCD, woven speaker grille. Background #eeeae3, foreground #302e29, secondary text #686258, action #a6452c, display #edcf88 on #292a23. System sans serif and monospace display fonts: offline, no font requests.
Use Radix Dialog for focus management. Buttons >=44px, visible keyboard focus, labels for every control. Press feedback scale .97 for 120ms cubic-bezier(.23,1,.32,1); keyboard and reduced-motion interactions have no motion. No decorative perpetual animation or fake equalizer. Real playback state controls the on-air indicator. Station ticks are indices, never simulated MHz.

## Additional user-specified themes
Vitreous: cyan/violet ambient light, glass panel, Outfit and Space Mono bundled locally, circular play key. LED: scoped 9×9×3 CSS cube, cyan/magenta/ice faces, 2D/3D controls, bounded stage/floor light. Both preserve the existing audio element and real playback state. Decorative visuals stop when paused or under reduced motion; controls remain keyboard operable. Theme/view preferences live in localStorage.

Cloud-white / soft: Oleksandr Plyuto for heartbeat, Dribbble shot 11629433. Ice-blue white chassis, low-saturation green inset circular station-index display, radial ticks, soft light/shadow elevation, ribbed functional tuner slider and volume control. Use readable slate text, green action accent, standard keyboard-operable range inputs. Responsive hardware layout reduces to tuner and level units on mobile. No Braun branding, fake MHz or decorative EQ controls.

## User-confirmed restraint
Brand: 阿喵收音机 (meowRadio technical identifier), original logo from issue #1. Login is a standalone /login page. Home exposes only search + one filter entry; never place the full filter form or lists of facets on home. Show only the active count on the trigger. Use a focus-trapped dialog / mobile bottom sheet with Apply/Reset and discard uncommitted edits on close. Country/language/type/sort are inside; audio refinements stay collapsed.

## Appearance and timed shutdown
Chinese/English language and light/dark color mode are independent settings, kept inside the existing settings panel. All four skins have both palettes; material and accent follow the skin. Sleep timer is a clock with two draggable hands, numeric/keyboard alternatives, and a single main-view entry. Final countdown emphasis appears only at its configured threshold, uses stable tabular digits and a gentle decorative halo, and is static for reduced-motion users. No repeated screen-reader announcement each second.
