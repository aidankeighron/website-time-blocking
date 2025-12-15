I want to create a chrome and firefox extension to help control website usage.

The way it will work is you will configure these extensions is by setting a taget list of websites and their blocking types.

For the extension setting page you will be able to add and remove websites from the list of target websites. This extension is mainly designed to work with instagram, reddit, and youtube but should also work for other websites.

When a target website has been opened. A prompt should be displayed that can not be closed, forcing the user to interact with it before proceding to the website.

The prompt will have the user select the blocking type and config they want to use before continuing to the app.

The types are unlimited, duration, and count, you switch through the different types using a horizontal button menu at the top of the extension. All the buttons are in a line next to each other and only one button can be selected at a time, the text inside the button coresponds to the blocking type, when switching blocking types the content of the prompt will switch to reflect the configuration needed for each blocking type.

The unlimited type has no further configuration and lets you use the app for as long as you want with no cooldown or other configuration it will display a counter specifying the number of unlimited uses you have left for today.

The duration session type will contain a numerial text box to specify the number of minutes you want to use the website for. This number needs to be positive and nonzero. Once a number has been selected and the confirm button has been pressed, you are allowed to continue to the website. Once the specified time has ellapsed the website will go on cooldown and the website will be redirected so you cant continue using it, while the cooldown is active you are not able to start a duration or count session. You can still start an unlimited session as long as you have some left. You can configure the cooldown duration in the settings.

The count session type is only available for youtube. It will let you watch count number of videos. The extension will keep track of every new video you open and if you try to open a video past the count limit you will get redirected. Once the cooldown is done you can start a new session. The cooldown starts when you open the last video, the X numberd video that is equal to the count.

For the settings page, you will be able to set the target websites. The number of unlimited session usages, and the cooldown durations, in minutes, for each session type.

The UI shoud be simplistic, rounded, and colorfull with purple being the accent color, it should also be in dark mode.

The extension should work for firefox and chrome, if needed they can be seprate folders.

Make sure to save all relevent data to session stoarge to keep track of values.