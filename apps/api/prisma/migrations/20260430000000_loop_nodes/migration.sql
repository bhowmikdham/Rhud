-- Loop nodes: a `loop` node has a body of child nodes (linked by
-- parent_node_id) that the runtime iterates N times. Open-ended
-- ("Add another?" prompt) only for now; binding to an upstream count
-- node comes later.
--
-- Schema impact:
--   • template_nodes.parent_node_id: self-FK; child nodes belong to a loop body.
--   • template_nodes.loop_config: opt-in JSONB for per-loop options (mode, label).
--   • template_nodes node_type CHECK: add 'loop'.
--   • engagement_answers.iteration_index: which loop iteration the answer
--     belongs to. 0 for non-loop answers.
--   • UNIQUE replaced (engagement, node) -> (engagement, node, iteration).
--   • engagements.loop_state: JSONB cursor map {loopId: {iter, status}}.

ALTER TABLE "template_nodes"
  ADD COLUMN "parent_node_id" UUID,
  ADD COLUMN "loop_config"    JSONB;

ALTER TABLE "template_nodes" DROP CONSTRAINT "template_nodes_node_type_check";
ALTER TABLE "template_nodes" ADD  CONSTRAINT "template_nodes_node_type_check"
  CHECK ("node_type" IN (
    'single_select','multi_select','short_text','long_text',
    'number','file_upload','section','loop'
  ));

ALTER TABLE "template_nodes"
  ADD CONSTRAINT "template_nodes_parent_node_id_fkey"
  FOREIGN KEY ("parent_node_id")
  REFERENCES "template_nodes"("id")
  ON DELETE CASCADE;

CREATE INDEX "template_nodes_parent_node_id_idx" ON "template_nodes"("parent_node_id");

-- engagement_answers: iteration_index + new unique
ALTER TABLE "engagement_answers"
  ADD COLUMN "iteration_index" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "engagement_answers" DROP CONSTRAINT IF EXISTS "engagement_answers_engagement_id_node_id_key";
ALTER TABLE "engagement_answers"
  ADD CONSTRAINT "engagement_answers_eng_node_iter_key"
  UNIQUE ("engagement_id", "node_id", "iteration_index");

-- engagements: loop_state cursor
ALTER TABLE "engagements"
  ADD COLUMN "loop_state" JSONB NOT NULL DEFAULT '{}'::jsonb;
