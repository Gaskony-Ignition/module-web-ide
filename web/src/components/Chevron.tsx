/**
 * The expand/collapse triangle.
 *
 * Its own module so the script tree and the Web Dev tree cannot drift into two
 * differently-sized chevrons, which is exactly what happened to the icons before
 * Icons.tsx existed.
 */
import { IconChevronDown, IconChevronRight } from './Icons';

export function Chevron({ open }: { open: boolean }) {
  return (
    <span className="file-tree-chevron" aria-hidden="true">
      {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
    </span>
  );
}
