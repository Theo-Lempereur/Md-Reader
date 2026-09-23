/** Entrée du chunk IA, chargée par `lazy(() => import("./ai"))` seulement
 * quand l'assistant est configuré ou que l'utilisateur ouvre sa
 * configuration. Rien ici n'est importé au démarrage de l'application. */

import "./ai.css";

export { AiHost } from "./AiHost";
export { AiDiffPanel } from "./components/AiDiffPanel";
