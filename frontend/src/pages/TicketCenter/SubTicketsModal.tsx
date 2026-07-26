import { Modal, Table, Typography } from "antd";
import { hoursDeviation } from "../../api/types";
import type { SubTicket } from "../../api/types";

export default function SubTicketsModal({
  open,
  onClose,
  ticketCode,
  subTickets,
}: {
  open: boolean;
  onClose: () => void;
  ticketCode: string;
  subTickets: SubTicket[];
}) {
  return (
    <Modal title={`子需求 - ${ticketCode}`} open={open} onCancel={onClose} footer={null} width={960}>
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={subTickets}
        columns={[
          {
            title: "TAPD地址",
            dataIndex: "tapdUrl",
            width: 90,
            render: (url: string | null) =>
              url ? (
                <a href={url} target="_blank" rel="noreferrer">
                  查看
                </a>
              ) : (
                <Typography.Text type="secondary">-</Typography.Text>
              ),
          },
          { title: "标题", dataIndex: "title", ellipsis: true },
          { title: "产品经理", dataIndex: "productManager", width: 90 },
          { title: "开发人员", dataIndex: "developer", width: 90 },
          { title: "测试人员", dataIndex: "tester", width: 90 },
          { title: "处理人", dataIndex: "currentHandler", width: 90 },
          { title: "TAPD状态", dataIndex: "tapdStatus", width: 90, render: (v: string | null) => v ?? "-" },
          { title: "预估工时", dataIndex: "estimatedHours", width: 80 },
          { title: "完成工时", dataIndex: "actualHours", width: 80 },
          {
            title: "工时偏差",
            width: 80,
            render: (_, r: SubTicket) => {
              const d = hoursDeviation(r);
              const cls = d >= 5 ? "dev-red" : d > 0 ? "dev-yellow" : "";
              return <span className={cls}>{d}</span>;
            },
          },
        ]}
      />
    </Modal>
  );
}
