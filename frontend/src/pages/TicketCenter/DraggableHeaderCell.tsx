import type { CSSProperties, HTMLAttributes, MouseEvent as ReactMouseEvent } from "react";
import { useRef } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface Props extends HTMLAttributes<HTMLTableCellElement> {
  columnKey?: string;
  // 列宽拖拽：跟 columnKey（列顺序拖拽）是两回事，固定列也需要能调整宽度
  resizeKey?: string;
  width?: number;
  onResize?: (key: string, width: number) => void;
}

const MIN_COLUMN_WIDTH = 60;

// 表头单元格：支持通过拖拽标题调整列的顺序（固定列不传 columnKey，不可拖拽），
// 以及通过拖拽右边缘调整列宽（所有列都支持，包括固定列）。
//
// 之前调整列宽时用 react-resizable 一直拿不到拖拽手柄的事件：dnd-kit 的拖拽监听是绑到
// 包着标题文字的 <span> 上的，如果调整列宽的拖拽手柄也被塞进这个 span 内部（或者被拖拽库
// 包裹整个表头单元格），手柄上的 mousedown 会先冒泡到这个 span 触发列顺序拖拽的判定逻辑，
// 抢在调整列宽的逻辑前面。这次改成手柄作为 <th> 的兄弟节点、放在 span 外面，两者互不嵌套，
// 事件不会冒泡穿过彼此，避免了同样的冲突，也就不需要再引入 react-resizable 这个库了
export default function DraggableHeaderCell({
  columnKey,
  resizeKey,
  width,
  onResize,
  children,
  ...restProps
}: Props) {
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

  const dragStateRef = useRef({ startX: 0, startWidth: 0 });

  function handleResizeStart(e: ReactMouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (!resizeKey || !onResize || width === undefined) return;
    dragStateRef.current = { startX: e.clientX, startWidth: width };
    document.body.classList.add("tc-resizing");

    function onMouseMove(ev: globalThis.MouseEvent) {
      const { startX, startWidth } = dragStateRef.current;
      const next = Math.max(MIN_COLUMN_WIDTH, Math.round(startWidth + (ev.clientX - startX)));
      onResize!(resizeKey!, next);
    }
    function onMouseUp() {
      document.body.classList.remove("tc-resizing");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    }
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  const resizeHandle = resizeKey && onResize && (
    <span
      className="tc-col-resize-handle"
      onMouseDown={handleResizeStart}
      onClick={(e) => e.stopPropagation()}
    />
  );

  if (!columnKey) {
    return (
      <th {...restProps} style={style}>
        {children}
        {resizeHandle}
      </th>
    );
  }

  return (
    <th {...restProps} ref={setNodeRef} style={style}>
      <span className="tc-col-drag-handle" style={{ cursor: "move", display: "block" }} {...attributes} {...listeners}>
        {children}
      </span>
      {resizeHandle}
    </th>
  );
}
