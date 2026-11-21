# The corpus

These 25 documents are what the lab retrieves from. They belong to
**Paddle Section Supply** (`paddlesectionsupply.example`), an invented
canoe and kayak outfitter in Ashby Landing, the gateway town for the
invented **Kettle Basin Canoe Area**. Permits and regulations come from
the equally invented **Kettle Basin Wilderness Office**. Every name,
place, product, phone number and domain is made up.

The corpus is fixed and reviewed. The question set (`questions/`) is
scored against exact spans of this text, so editing a document can make
an expected answer wrong. If you change one, run `npm run eval -- --check`
and rebuild the indexes (`npm run index`). The app warns at startup when
an index was built from a different corpus.

This file is not part of the corpus: the indexer skips `README.md`.

---

## The documents

| Folder | Document | What it is |
|---|---|---|
| `policies/` | `rental-agreement.md` | Who can rent, pickup and return times, late returns, care of equipment, the renter's responsibilities |
| | `rates-2026.md` | The current rate sheet: boats, gear, outfitting, shuttles, parking, fuel |
| | `rates-2025.md` | **Last season's rate sheet, still in the corpus** (see the traps) |
| | `cancellation-and-weather.md` | Refunds by notice period, closures, wind delays, leaving early |
| | `damage-and-loss.md` | The damage and loss charges, and the damage waiver |
| | `deposits-and-payment.md` | Deposit holds, release, deductions, payment methods |
| | `shuttle-service.md` | Tow boat and van schedules, booking, what rides along. No prices |
| `permits/` | `permit-rules.md` | Overnight and day-use permits, fees, and regulations KB-1 to KB-13 |
| | `entry-points.md` | Every entry point, with its code, access and daily quota |
| | `campsites-and-group-size.md` | Designated sites, group limits, stay limits, etiquette |
| | `changes-2026.md` | What the Wilderness Office changed this season |
| `routes/` | `route-ashby-lake-loop.md` | 2 days, 9 miles, beginner, from the outfitter's dock |
| | `route-fern-creek-ramble.md` | 3 days, 16 miles, beginner to intermediate |
| | `route-heron-chain-loop.md` | 4 days, 24 miles, intermediate, tow boat in |
| | `route-granite-river-run.md` | 5 days, 38 miles, advanced, one way |
| | `route-raven-narrows.md` | 3 days, 22 miles, intermediate, big open water |
| | `route-stillwater-traverse.md` | 6 days, 44 miles, advanced, one way |
| `gear/` | `boats-and-gear-catalog.md` | Specs for every boat and piece of rental gear. No prices |
| | `canoe-care.md` | Carrying, loading, landing and storing a canoe |
| | `pfd-sizing.md` | Life jacket sizes for adults, youth, children and infants |
| | `packing-list.md` | What to bring, and what the outfitter supplies |
| | `stove-and-fuel.md` | The rental stove, fuel rules and fire restrictions |
| `faq/` | `general-faq.md` | Common questions: dogs, parking, showers, cell service, discounts |
| | `first-trip-faq.md` | For beginners: choosing a route, portages and rods, safety |
| | `contact-and-hours.md` | Hours, address, phone, email, the after-hours drop |

25 documents, 26,586 words (measured with `wc -w`, Markdown included).

---

## The traps

Every trap below was written in deliberately, at build step 2, before
anything was measured (PLAN §11). They're listed here so you can find
them, and so nobody mistakes them for mistakes.

### 1. A stale document: the 2025 rate sheet

`policies/rates-2025.md` is a complete rate sheet for last season, left
in the corpus next to `rates-2026.md`, the way old files linger on real
websites. **Nothing in it says it has been replaced.** Only the title
and the effective date say 2025. It differs from 2026 in the boat
rental rates, the damage waiver, both outfitting packages, all five
shuttles and parking. For example, a Northline 17 Kevlar canoe is
**$64 a day in 2026** and **$58 in 2025**, and the EP-14 tow boat
shuttle is **$95 in 2026** and **$80 in 2025**. Both sheets use the
same layout and wording, so their chunks embed almost identically, and
retrieval has no reason to prefer the current one.

*Stale questions* test whether the answer gives the 2026 figure, or at
least notices that the two documents disagree.

### 2. A subject named in a different chunk

Three long sections name their subject only in their heading and first
paragraph. The answer sits in the section's last paragraph, which calls
the subject only "this fee", "it" or "they":

| Document | Section | The last paragraph says | without naming |
|---|---|---|---|
| `policies/rental-agreement.md` | Late returns and the late fee (557 words) | when "this fee" is waived (a Wilderness Office closure, or a wind advisory on the exit day) | the late fee |
| `policies/damage-and-loss.md` | Damage waiver (488 words) | what "it" doesn't cover (negligence, towing, gear other than boats) | the damage waiver |
| `permits/permit-rules.md` | Day-use permits (499 words) | that "they" cost nothing, one per group, carried in the boat | day-use permits |

Each section is longer than one default chunk, so `heading` chunking
splits it. The chunk holding the answer then doesn't say what it's about.
`heading+context` prepends the heading path before embedding, which is
the fix these *split context* questions measure.

### 3. Long tables that fixed-size chunking splits

- Both rate sheets hold every price in **one 29-row table**.
- `policies/damage-and-loss.md` holds every charge in **one 23-row table**.

`fixed` chunking cuts these mid-table, so a chunk can start with rows
whose header row is in a different chunk. The PLAN §7 walkthrough uses
this: switch to `fixed`, and the late-fee answer can go wrong while
citing a chunk that looks right. *Table* questions need a single row.

### 4. Exact identifiers

Entry point codes (`EP-07`, `EP-14`, `EP-22` and so on), regulation codes
(`KB-1` to `KB-13`) and product names (`Kestrel 15`, `Driftline 21`,
`StormCell 2`, `Portage Pro 60`) are short tokens that carry almost no
meaning for an embedding model. Keyword search finds them at once, and
vector search may not. *Exact term* questions use them.

### 5. Answers that need two documents

**Entry point codes are mapped to names in exactly one place:** the table
in `permits/entry-points.md`. Route guides name entry points only by
place ("the Heron Lake entry point"), and the rate sheets list shuttles
only by code ("EP-14, tow boat"). So:

- "What's the longest portage on the route that starts at EP-14?" needs
  `entry-points.md` (EP-14 is Heron Lake) and then
  `route-heron-chain-loop.md` (the Cutfoot carry, 290 rods).
- "How much is the shuttle for the Heron Chain Loop?" needs the route
  guide (Heron Lake, tow boat), then `entry-points.md`, then
  `rates-2026.md` (EP-14, $95). It's also exposed to the stale sheet.
- "What's the daily quota at the Granite River Run's entry point?"
  needs the route guide (the Upper Granite River put-in) and then
  `entry-points.md` (EP-22, 6).

The route guides do drop hints without numbers. The Heron guide says its
entry point has "one of the smallest" quotas and was "reduced for
2026", and the Stillwater guide says Stillwater Lake has "the smallest
daily overnight quota of any entry point we serve". A model may lean on
those hints instead of retrieving the table.

*Multi-hop* questions use these chains. Pre-retrieval runs one search,
so it rarely gets both documents; search-tool mode can search again.

### 6. Near-duplicates and decoys

- **"Lift it, don't drag it."** The same advice, worded slightly
  differently each time, appears in `policies/rental-agreement.md`
  (word for word: "Never drag a canoe over rocks or the landing; lift it
  clear, even for a few feet"), `gear/canoe-care.md` and
  `faq/general-faq.md`.
- **Kevlar is light but brittle.** Similar paragraphs in
  `gear/canoe-care.md` and `gear/boats-and-gear-catalog.md`.
- **The Ashby Lake Loop's portage table** appears in both
  `routes/route-ashby-lake-loop.md` and `faq/first-trip-faq.md`, with
  the same numbers.
- **Decoys without the number.** `faq/general-faq.md` answers questions
  about late returns, deposits, damage and cancellations in loose terms
  and points to the policy documents, without giving amounts. These
  chunks match the question's wording closely and can outrank the chunk
  that holds the answer, which fills top-k with text that sounds right
  and answers nothing.
- **One number, two meanings.** `$35` is both the late fee
  (`rental-agreement.md`) and the charge for a broken tent pole
  (`damage-and-loss.md`). `$72` is a partial-outfitting day, a
  sleeping-bag week and a 2025 Wayfarer day. Scoring matches required
  facts in the answer text, not in the chunks, so this doesn't affect
  scores, but it's worth knowing when you read a log.

### 7. Rules that changed this season

`permits/changes-2026.md` and the regulations themselves record four
changes: group size cut from 10 to 9 people (KB-3), the EP-14 quota cut
from 12 to 8, bear-resistant containers now required on Heron, Gull and
Cutfoot lakes (KB-7), and permit pickup allowed up to 24 hours ahead.
Old values appear only as "before 2026" or "was", so they're
history, not stale facts. The question set doesn't score on them.

---

## Deliberately absent

These topics appear **nowhere** in the corpus, so questions about them
are *unanswerable* questions. The right answer is "the documents don't
say", and no-retrieval mode will usually invent one anyway:

- stand-up paddleboards
- fishing of any kind: licenses, rules, species, bait
- cabins, lodging or places to stay
- guided trips
- motorboat rentals
- winter or ice trips
- prices for anything not on the rate sheets

The corpus was searched for these words after it was written. The only
matches were unrelated uses like "beaver lodges".
