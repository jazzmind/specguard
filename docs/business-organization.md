# Output destinations and business organization

Use the workspace as the business-level view of the system. Application dashboards remain the place to work on a particular frontend, backend, admin application or service. An overlay stores their shared artifacts; it is not another application to initialize.

## Choose where generated files go

The editor's Generate, Reverse, Import, Docs and Gap Analysis actions show the application, code/config roots and destination before generation. Generate first asks for unit, integration or e2e. Existing test directories are suggested, including a nearby overlay Playwright journey harness. A `tags/` directory is identified as a mapping directory rather than executable test output. An explicit saved destination wins over suggestions.

The selected folder is remembered per application and output kind in `.specguard/output-locations.json`, relative to the resolved config root. Different layers can use different repositories. Generated directories join test discovery while existing native test sources stay intact. For example, unit tests can remain in a Java app and browser journeys can live in the overlay. Choosing a directory does not rewrite an existing runner's test include patterns or start tests; configure the runner to include newly introduced locations.

```sh
specguard outputs --json
specguard outputs --app api --kind tests.e2e --directory ../../e2e/journeys
specguard outputs --app api --kind docs --directory docs/user
specguard generate --app api --all --type e2e --framework playwright
```

Kinds: `specs`, `tests.unit`, `tests.integration`, `tests.e2e`, `docs`, `plans`. The CLI uses saved locations non-interactively; the editor supplies the destination chooser. Explicit `docs --out` remains a one-run override. Gap Analysis supports `--app` to scope the selected application. Runtime reports, ledgers and configuration remain in their existing configuration/workspace locations; selecting an output folder does not relocate proof state.

Changing a spec root copies its existing Markdown into the new root, preserves canonical keys (including a former prefix under `specsRoot`), and retains the originals. A conflicting destination is refused before copying. Ancestor/child destinations are refused. The editor explains this before the copy. Test and documentation destination changes leave existing files in place.

## Workspace business journeys

Open **Workspace → Business journeys**, or run **SpecGuard: Business Journeys** from the Command Palette.

The view holds a business overview, logical groups and ordered journeys. A journey contains ordered steps with expected outcomes and links to features, specs or individual claims across applications. Link references include the workspace repo key, such as `api:capabilities/payment#charge-once`. They continue to identify the same requirement when its displayed group or order changes.

Use **Add group**, **Add journey**, **Add step**, **Edit links / outcome**, and the arrow buttons to organize the system. Edits save to the workspace's `.specguard/experience.json`. Removing organization does not delete specs, features, code or tests. Missing references remain visible so a renamed or removed requirement cannot silently disappear from a journey.

## Application features and specs

Open an application dashboard's **Evidence → Specs → Organize features & specs**, or use **SpecGuard: Organize Features and Specs**. The application view shows both catalog features and specs, with **Change group** and ordering arrows. Its organization is saved beside the application's resolved config, including an overlay config.

Unassigned application entries inherit grouping/order from journey steps in the nearest workspace manifest. Catalog features inherit the placement of linked specs as well. An explicit application placement takes precedence. Reorganization changes presentation metadata, not catalog/spec identities or filenames. The dashboard's spec inventory uses the same organization.

## Draft and update safely

**Draft / update from specs** uses the application's configured provider/model (and the editor's inherited settings) to propose an overview, groups, journeys and placements. Workspace drafting uses the first configured participating application's model. Configure that application's AI settings before drafting. The draft uses current spec descriptions, claim refs and feature catalogs; a generated reference that does not exist is refused.

**Review draft diff** compares current organization to the proposed document. **Apply draft** activates it. Existing text, ordering, groups and references survive automatic refresh; proposals add new organization. Adding steps returns a reviewed journey to draft status. A proposal cannot be applied after its inputs or the active organization changed. Reload and draft again. Concurrent editor saves also require the revision originally opened.

Drafting does not approve requirements or prove behavior. Journey review status concerns organization only; test results, required layers and evidence freshness retain their existing meaning.

```sh
specguard experience --workspace /path/to/workspace --json
specguard experience --workspace /path/to/workspace --action draft
specguard experience --workspace /path/to/workspace --action apply
specguard experience --config /path/to/overlay/apps/api --json
```

CLI editing uses `--action save --revision <opened-revision> --data '<document-json>'`. An omitted `--workspace` selects application organization. Drafts are stored in `.specguard/experience.draft.json` until applied. This supports an agent/CLI workflow using the same state and validation as the VSIX.
