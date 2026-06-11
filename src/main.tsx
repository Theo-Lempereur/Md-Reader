import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

type BoundaryState = { error: Error | null };

/** Filet de sécurité : sans boundary, la moindre exception de rendu démonte
 * toute l'app (page blanche) sans aucun moyen de récupérer. La session étant
 * persistée (localStorage + store Tauri), recharger restaure les onglets. */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  BoundaryState
> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Crash de l'interface :", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          height: "100vh",
          padding: 24,
          fontFamily: "system-ui, sans-serif",
          textAlign: "center",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 20 }}>
          Une erreur inattendue est survenue
        </h1>
        <p style={{ margin: 0, opacity: 0.7, maxWidth: 480 }}>
          L'interface a rencontré un problème. Recharger restaurera votre
          session (les modifications non sauvegardées depuis la dernière
          sauvegarde peuvent être perdues).
        </p>
        <pre
          style={{
            maxWidth: 560,
            maxHeight: 160,
            overflow: "auto",
            fontSize: 12,
            opacity: 0.6,
            whiteSpace: "pre-wrap",
          }}
        >
          {String(this.state.error)}
        </pre>
        <button
          onClick={() => window.location.reload()}
          style={{ padding: "8px 16px", cursor: "pointer" }}
        >
          Recharger l'application
        </button>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
);
