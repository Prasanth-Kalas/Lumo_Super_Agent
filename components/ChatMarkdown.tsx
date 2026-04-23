"use client";

/**
 * Thin wrapper around react-markdown with the GFM plugin (tables,
 * strikethrough, task lists, autolinks). Lives in its own file so the
 * chat page stays readable and so the server bundle doesn't try to
 * include the markdown parser.
 *
 * Styling is applied via the `.lumo-prose` class in globals.css — keeping
 * it in CSS (not component-level className soup) means copy tweaks don't
 * require rebuilding the component.
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  /** Raw markdown string streaming in from the orchestrator. */
  children: string;
}

export function ChatMarkdown({ children }: Props) {
  return (
    <div className="lumo-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // All external links open in a new tab — users click these
          // to check a carrier website, a restaurant menu, etc., and
          // losing chat state to navigation is painful.
          a: ({ href, children, ...rest }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              {...rest}
            >
              {children}
            </a>
          ),
          // We wrap tables so horizontal overflow on narrow screens
          // scrolls inside the bubble rather than pushing the whole
          // chat wider than the viewport.
          table: ({ children, ...rest }) => (
            <div className="overflow-x-auto">
              <table {...rest}>{children}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
