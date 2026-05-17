import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ExamplesPage } from "./components/ExamplesPage";
import { LandingPage } from "./components/LandingPage";
import { NeuronView } from "./components/NeuronView";
import { NotFound } from "./components/NotFound";
import { TableRowsView } from "./components/TableRowsView";
import { TableView } from "./components/TableView";
import { Workspace } from "./components/Workspace";
import { FeatureExplorer } from "./components/explore/FeatureExplorer";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 0,
      refetchOnWindowFocus: false,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true,
        }}
      >
        <Routes>
          <Route path="/" element={<Workspace />}>
            <Route index element={<LandingPage />} />
            <Route path="neuron" element={<NeuronView />} />
            <Route path="tables" element={<TableView />} />
            <Route path="tables/:name" element={<TableRowsView />} />
            <Route path="examples" element={<ExamplesPage />} />
            <Route path="explore" element={<FeatureExplorer />} />
            {/* Catch-all inside the Workspace shell so the sidebar +
                breadcrumb stay rendered around the 404 message —
                makes recovery (typing a new id, going to tables) feel
                continuous rather than dropping the user onto a bare
                error page. */}
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
