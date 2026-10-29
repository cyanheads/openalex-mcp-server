---
name: openalex-guide
description: Gates and identifier chains for the openalex_* tools — which filter key answers the question (topic or text, institution or its lineage, venue, funders or awards), how to read group_by counts, where W/A/S/I/T/P/F/G IDs come from, and how to pin an author without picking a namesake. Use when answering literature, citation, bibliometric, author, institution, or research-funding questions with openalex_* tools.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

OpenAlex is a CC0 catalog of scholarly metadata: works, authors, sources (journals, repositories, conferences), institutions, topics, keywords, publishers, funders, and awards (grants). Reach for it to find literature and to count it: who published what, where, with whom, funded by whom, and who cites it.

Not here: article full text (a work carries an abstract when OpenAlex has one, and a readable copy's link in `best_oa_location`), trial registries, MeSH indexing, and other databases' citation counts. `cited_by_count` and every count here are OpenAlex's own tallies; cite them as such. Concept IDs (`C…`) are retired; topics replace them.

## Identifiers

| ID | Entity | Where it comes from |
|:---|:-------|:--------------------|
| `W…` | work | search results, the citation graph, `openalex_resolve_name` on a title, DOI, or PMID |
| `A…` | author | `openalex_resolve_name` on a name or ORCID; a work's `author_list` or `authorships` |
| `S…` | source | `openalex_resolve_name` on a name or ISSN; a work's `primary_location.source` |
| `I…` | institution | `openalex_resolve_name` on a name or ROR; a work's `authorships` |
| `T…` | topic | `openalex_resolve_name` with entity_type topics; a work's `primary_topic` |
| field, subfield, domain | topic hierarchy | a topic record's `field`, `subfield`, `domain`; filter with the trailing number (`primary_topic.field.id: "13"`) |
| slug | keyword | `openalex_resolve_name` with entity_type keywords; keyword IDs are slugs (`groundwater`), never `K…` |
| `P…` | publisher | `openalex_resolve_name`; a journal's `host_organization` (a repository's names its host institution instead) |
| `F…` | funder | `openalex_resolve_name` on a name, ROR, or Funder Registry DOI; a work's `funders` |
| `G…` | award | no name lookup: `openalex_search_entities` on entity_type awards (`query`, or the `funder_award_id` filter); a work's `awards` |

## Gates

### Pick the filter key that matches the question

Each pair returns a different population. Choose deliberately, and name the key in the answer.

- **Topic or text.** `primary_topic.id` holds works whose main topic is T; `topics.id` holds works carrying T among any of their topics, a much larger set. `query` also matches full text where OpenAlex holds it, so it returns works that only mention a phrase; the `title_and_abstract.search` filter keeps to works about it.
- **Institution or lineage.** `authorships.institutions.id` counts that exact institution; `authorships.institutions.lineage` adds its child institutions (affiliated hospitals, institutes). Rankings shift between the two.
- **Venue.** `primary_location.source.id` is where a work was published. `locations.source.id` matches any copy, so a repository or preprint server counts every deposited version: arXiv holds more than twice as many works by `locations` as by `primary_location`.
- **Funding.** On works, `funders.id` holds works that acknowledge a funder, and `awards.funder_id` the smaller set matched to one of its specific grants. The `awards` entity holds the grants themselves, with amounts, dates, and investigators. An agency and its sub-agencies are separate funders (NIH and each of its institutes has its own `F…` ID, and a work often lists both): OR the IDs when the question means the whole agency.

### Read group_by counts against `meta.count`

- A multi-valued field (institutions, countries, authors, topics, funders, sources at any location) counts a work once in every group it belongs to, so the groups can sum past the total; a work with no value falls in no group unless `group_by` ends in `:include_unknown`, so the sum can also fall short. Compute shares with `meta.count` as the denominator, never the group sum. Single-valued fields (`publication_year`, `type`, `oa_status`) partition the total.
- The current year is partial. Its point on a trend is not a decline; stop at the last full year or label it "to date".
- On awards, groups count grants, not dollars (Funding behind a topic, step 4).

### Pin the author before listing works

1. Holding an ORCID, skip the name: `openalex_resolve_name` takes the ORCID directly, and the works filter `authorships.author.orcid` takes it without an author ID.
2. A name returns at most 10 matches, and a common name has thousands of profiles, so the right person may not be among them. Narrow with `filters` on entity_type authors, `last_known_institutions.id` or `affiliations.institution.id` (any past affiliation), before choosing.
3. Matches can include other forms of the name ("W. Wang" for "Wei Wang"), so check `display_name` first. Choose by the `hint` (last institution), `works_count`, and topics, then confirm on one paper you know is theirs: their `A…` ID must appear in its `author_list`.
4. A person can have stray or split profiles beside the main one. OR every confirmed `A…` ID in `authorships.author.id`; never add an unconfirmed namesake.

### Reproducible samples

A seed reproduces a draw from the same filters, but OpenAlex updates its catalog continuously. Keep the drawn IDs, and record the seed, the exact filters, and the retrieval date with them. For a stratified sample, draw one seeded sample per stratum filter, sized from that stratum's `analyze_trends` count.

## Workflows

### Who leads a field, and how output moved

1. Resolve the topic to `T…` (or take a field or subfield ID from its record for a broader cut).
2. `openalex_analyze_trends` on works, `group_by` `authorships.institutions.id` (or `.lineage`), filtered by the topic and a `publication_year` range: the ranking.
3. For each leader, group by `publication_year` with the institution ID added to the same filters: its trend.

### Who cites a work, and where

- The distribution of citing works by venue, institution, country, or year is one `openalex_analyze_trends` call on works with the `cites` filter set to the `W…` ID, grouped by the field you want. It costs far less than paging the graph.
- `openalex_get_citation_graph` direction `cites`, sorted `-cited_by_count`, lists the citing works themselves; take venue from `primary_location.source`.

### Funding behind a topic

1. Count funders of the topic's works: `openalex_analyze_trends` on works, `group_by` `funders.id`, filtered by the topic.
2. Reach the grants from the works side: group the topic's works by `awards.id`, which ranks grants by how many of those works each funded. Few awards carry a topic classification of their own, so an awards search filtered by topic is a lower bound, not the topic's grants. A work's `awards` field names its `G…` IDs; works filtered by `awards.id` are one grant's outputs.
3. A grant number is not unique: one `funder_award_id` can sit on award records of different funders. Narrow with the `funder.id` filter before treating a record as the grant.
4. Funding totals: `amount_usd` is converted from `amount` and `currency`; many awards carry none, and some carry 0 or a negative value. Page the awards, sum `amount_usd`, and report how many awards the sum covers. Never present it as the full amount.
