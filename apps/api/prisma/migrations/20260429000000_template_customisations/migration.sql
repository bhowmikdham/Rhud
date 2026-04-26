-- Sprint 7 (interim) — template customisations.
--
-- Three additions, all backward-compatible:
--
--   1. `template_nodes.help_text` — guidance shown to the responder under the
--      question. The questionnaires this is modelled on are full of "Kindly
--      mention the count of the assets" style hints; we want a first-class
--      slot for them rather than overloading `question`.
--
--   2. `template_nodes.placeholder` — input hint (e.g. "e.g. 38").
--
--   3. `template_nodes.required` (default TRUE) — skipped fields are useful
--      for optional notes columns ("Complete Details, if Any").
--
--   4. New `node_type` value: `section`. A section node has no answer; it
--      renders as a heading + description divider in the runtime. Existing
--      next-rule machinery handles flow through it (default `always → next`).

ALTER TABLE "template_nodes"
  ADD COLUMN "help_text"  TEXT,
  ADD COLUMN "placeholder" TEXT,
  ADD COLUMN "required"    BOOLEAN NOT NULL DEFAULT TRUE;

-- Drop + re-add the node_type CHECK with the new 'section' value.
ALTER TABLE "template_nodes" DROP CONSTRAINT "template_nodes_node_type_check";
ALTER TABLE "template_nodes" ADD  CONSTRAINT "template_nodes_node_type_check"
  CHECK ("node_type" IN (
    'single_select','multi_select','short_text','long_text',
    'number','file_upload','section'
  ));
