/* global React, ReactDOM, Sidebar, TopBar, EventDrawer, Dashboard, RunsList, RunDetail, ApprovalsPage, NewSpec, WorkflowBuilder, ArtifactsPage, SettingsPage, NAV_ITEMS */
const { useState, useEffect } = React;

const App = () => {
  const data = window.PMGO_DATA;
  const [route, setRoute] = useState("dashboard");
  const [activeRun, setActiveRun] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const counts = {
    runs: data.runs.filter(r => ["running","in_review","blocked","fixing"].includes(r.status)).length,
    approvals: data.approvals.length,
  };

  const onOpenRun = (run) => { setActiveRun(run); setRoute("run-detail"); };
  const onBack = () => { setRoute("runs"); };
  const onOpenApproval = (a) => { setRoute("approvals"); };

  const renderPage = () => {
    switch (route) {
      case "dashboard":  return <Dashboard data={data} onOpenRun={onOpenRun} onOpenApproval={onOpenApproval} onGoto={setRoute} />;
      case "runs":       return <RunsList data={data} onOpenRun={onOpenRun} selectedRunId={activeRun?.id} />;
      case "run-detail": return activeRun ? <RunDetail data={data} run={activeRun} onBack={onBack} /> : null;
      case "approvals":  return <ApprovalsPage data={data} onOpenRun={onOpenRun} />;
      case "new-spec":   return <NewSpec data={data} onCreate={() => setRoute("runs")} />;
      case "workflow":   return <WorkflowBuilder data={data} />;
      case "artifacts":  return <ArtifactsPage data={data} />;
      case "settings":   return <SettingsPage />;
      default:           return <Dashboard data={data} onOpenRun={onOpenRun} onOpenApproval={onOpenApproval} onGoto={setRoute} />;
    }
  };

  // Route → sidebar nav id mapping (run-detail highlights "runs")
  const sidebarRoute = route === "run-detail" ? "runs" : route;

  return (
    <div className="app">
      <Sidebar route={sidebarRoute} onNavigate={setRoute} counts={counts} />
      <TopBar
        route={route}
        activeRun={activeRun}
        stack={data.stack}
        onDiagnose={() => setDrawerOpen(true)}
        onOpenSpec={() => setRoute("new-spec")}
      />
      <main className="main">
        <div className="main-scroll" data-screen-label={route}>
          {route === "run-detail" ? renderPage() : (
            <>{renderPage()}</>
          )}
        </div>
        <EventDrawer open={drawerOpen} onToggle={() => setDrawerOpen(o => !o)} events={data.events} />
      </main>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
