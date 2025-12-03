import React from 'react';
import { createRoot } from 'react-dom/client';
// You might need to import your main CSS file here if you created it in Step 3 of the previous response
import './index.css'; 
import SignLanguageTranslator from './App'; // Import the main component from App.jsx

// Get the root element defined in public/index.html
const container = document.getElementById('root');
const root = createRoot(container); // Create a root

// Render the main component into the root container
root.render(
  <React.StrictMode>
    <SignLanguageTranslator />
  </React.StrictMode>
);