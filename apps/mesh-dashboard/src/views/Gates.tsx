/**
 * Tool gates is the inbox opened on its tool section.
 *
 * It was a view of its own, so "Needs you" could say "all clear" while a tool request waited one click away. The route still
 * works (the sidebar entry, a bookmark, the top bar when a tool request is the only thing waiting), and it is the same
 * component as `escalations` on purpose: React sees one component type in both places, so switching tabs keeps the page and
 * its data instead of loading it again.
 */
export { default } from "./Escalations";
