import { Navigate, Route, Routes } from "react-router-dom";
import Login from "./pages/Login";
import AppShell from "./layout/AppShell";
import TicketCenter from "./pages/TicketCenter/TicketCenter";
import Home from "./pages/Home/Home";
import DevHours from "./pages/DevHours/DevHours";
import DeptStats from "./pages/DeptStats/DeptStats";
import AccountConfig from "./pages/AccountConfig/AccountConfig";
import ChangeLogs from "./pages/ChangeLogs/ChangeLogs";
import DeptConfig from "./pages/DeptConfig/DeptConfig";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<AppShell />}>
        <Route index element={<Navigate to="/tickets" replace />} />
        <Route path="home" element={<Home />} />
        <Route path="tickets" element={<TicketCenter />} />
        <Route path="dev-hours" element={<DevHours />} />
        <Route path="departments" element={<DeptStats />} />
        <Route path="account-config" element={<AccountConfig />} />
        <Route path="change-logs" element={<ChangeLogs />} />
        <Route path="dept-config" element={<DeptConfig />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
