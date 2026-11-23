import type { AnyExtension, JSONContent } from '@tiptap/core';
import '@tiptap/starter-kit';
import '@tiptap/extension-table';
import '@tiptap/extension-task-list';
import '@tiptap/extension-task-item';
import '@tiptap/extension-image';
export function markdownExtensions(): AnyExtension[];
export function inspectMarkdown(source: string):
  | { supported: true; document: JSONContent }
  | { supported: false; reason: string };
export function serializeMarkdown(document: JSONContent):
  | { ok: true; markdown: string }
  | { ok: false; reason: string };
export function markdownSemantics(source: string): unknown;
export function safeLink(value: string): boolean;

export function safeImageSource(value: string): boolean;

export function preserveMarkdownBlocks(original: string, edited: string): string;
