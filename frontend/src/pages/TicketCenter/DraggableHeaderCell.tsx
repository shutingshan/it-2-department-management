import type { CSSProperties, HTMLAttributes } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface Props extends HTMLAttributes<HTMLTableCellElement> {
  columnKey?: string;
}

// 表头单元格：支持通过拖拽标题调整列的顺序（固定列不传 columnKey，不可拖拽）
export default function DraggableHeaderCell({ columnKey, children, ...restProps }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: columnKey ?? "",
    disabled: !columnKey,
  });

  const style: CSSProperties = {
    ...restProps.style,
    transform: CSS.Translate.toString(transform),
    transition,
    ...(isDragging ? { position: "relative", zIndex: 9, background: "#f0f2ff" } : {}),
  };

  if (!columnKey) {
    return (
      <th {...restProps} style={style}>
        {children}
      </th>
    );
  }

  return (
    <th {...restProps} ref={setNodeRef} style={style}>
      <span className="tc-col-drag-handle" style={{ cursor: "move", display: "block" }} {...attributes} {...listeners}>
        {children}
      </span>
    </th>
  );
}
