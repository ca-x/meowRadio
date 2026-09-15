# Search UX follow-up

Review scope: Chinese composition input, FM-name/frequency queries, filtering, pending state, recovery from empty results. This extends the initial application implementation.

| Before | After | Why |
| --- | --- | --- |
| Every input change searches after 350 ms, including incomplete IME text | Debounce starts after composition ends; Enter cannot prematurely submit composing text | Avoids sending intermediate pinyin and flashing irrelevant results |
| No explicit submit action | Enter or the search button submits immediately; pending debounce is cancelled | Clear keyboard and touch feedback without duplicate delayed resets |
| `ＦＭ １０４．２ MHz` is passed literally | NFKC normalization and conventional standalone FM frequency syntax become `104.2` | Matches the frequency text recorded in station names; does not imply RF scanning |
| Changing a query replaces results with skeletons | Prior results remain while a live status explicitly says they are previous results | Keeps layout stable and makes pending work visible |
| Filters can silently make a valid term look absent | A compact filter entry opens a draft form with Apply/Reset, plus an empty-state clear-filter action | Helps users recover without guessing which filter caused the empty state |
| Empty favorites search has only generic copy | Offers continuing the same query in all stations | Avoids a dead end |
| Escape can interfere with IME | Escape clears only outside composition | Preserves normal Chinese input cancellation |

Standalone filtering: full country/language/type directory loads only after opening the filter entry. Draft edits do not change the list until Apply; closing discards them. No keyword is required. Home contains no filter fields.

Validation: six dedicated search tests cover normalization, debounce, composition, immediate submit, clear cancellation, and external reset. Existing six playback tests continue to verify uninterrupted playback across all four themes. The service still searches Radio Browser directory entries; terrestrial-only FM without an internet stream is outside its scope.
