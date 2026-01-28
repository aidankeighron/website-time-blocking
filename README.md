# Website Time Blocking

A browser extension designed to bring intentionality to your browsing habits. Instead of hard blocking websites, it interrupts your visit to distracting sites, requiring you to set a specific time or content limit before proceeding.

## Features

- **Intention Prompt**: Intercepts visits to configured sites (e.g., Instagram, Reddit) and asks for session details.
- **Session Types**:
    - **Time Duration**: Set a timer (in minutes) for how long you want to browse.
    - **Video Count**: Limit usage by the number of videos watched (YouTube support).
- **Enforced Breaks**: Once a session ends, a cooldown period prevents immediate re-entry, helping break the loop of compulsive checking.
- **Customizable**: Manage your own list of target sites and configure cooldown durations via the settings page.

## Installation

### Chrome / Edge / Brave

1. Clone or download this repository.
2. Open your browser's extensions page (e.g., `chrome://extensions`).
3. Enable **Developer mode** (usually a toggle in the top right).
4. Click **Load unpacked**.
5. Select the folder containing `manifest.json`.

### Firefox

1. Clone or download this repository.
2. Type `about:debugging` in the address bar.
3. Click **This Firefox** in the sidebar.
4. Click **Load Temporary Add-on...**.
5. Select the `manifest-firefox.json` file from the project directory.

## Usage

1. Click the extension icon to access **Settings**.
2. Add the websites you want to manage (e.g., `twitter.com`).
3. When you visit a saved site, you will be redirected to an intervention screen.
4. Choose your session type (Time or Count) and set your limit to access the site.
