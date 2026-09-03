import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";

const md = new MarkdownIt({ html: false }).use(taskLists);

// Default live on; set live: false to update the preview only on save.
export const preview = {
  live: true,
};

export function renderPreview(markdown) {
  return md.render(markdown ?? "");
}
