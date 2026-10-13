---
title: Serverless Telegram Bot with Firebase
slug: serverless-telegram-bot-using-firebase-in-5-minutes
kind: post
date: 2019-02-23
status: published
category: code
tags: []
summary: Using (free) Firebase Cloud Functions to start your first telegram bot, as always with Javascript. 1. Create your bot Easy and fast: Search in telegram @BotFather or open this link Write the comman…
featured: wp-content/uploads/2019/02/telegram_bot.png
---

Using **(free)** Firebase Cloud Functions  to start your first telegram bot, as always with Javascript.

## 1. Create your bot

Easy and fast:

- Search in telegram @BotFather or open [this link](https://telegram.me/BotFather)

- Write the command “**/newBot**“

- Follow all the steps

- Write down 2 things :
- bot name (finished in ‘bot’): In our example **firebase_bot**

- Secret Token (don’t miss it): in our example **LONG_STRING_TOKEN**

![](assets/wp-content/uploads/2019/02/01-create-bot-714x768.png)

_Telegram bot creation_

## 2. Create your firebase project

Go to your firebase admin page

- Go to your firebase console [https://console.firebase.google.com](https://console.firebase.google.com)

- Add a new project

- **Write down the final id** of the project: in our example **firebase-bot-560a7**

![](assets/wp-content/uploads/2019/02/03-create-firebase-1024x858.png)

_Firebase project creation_

## 3. The code

I am going to assume you have Node and NPM installed in your system and you know how to use it

#### 3.1 Set the enviroment

- Install globally **firebase-tools**: npm install -g firebase-tools

- **Login**into firebase: **firebase login**

- Create a folder and run: npm init inside

- Init firebase in the same folder: firebase init

- Choose: **Functions: Configure and deploy Cloud Functions**

- Select a default Firebase project:
- We have a firebase project id created on the point 2.3, if this is shown in the options choose it

- If the project is not there choose **[create a new project]** (we will pick the project later)

- Javascript or Typescript: (IMHO) **Typescript**

- TSLint: Y**es**

- install npm dependencies: **Yes**

- If in the point 6 you didn’t choose your firebase project set it now with: **firebase use firebase-bot-560a7** (this has to be the id of your firebase project, point 2.3)

- install functions dependencies:
- **cd functions** folder

- **npm install –save express cors**

![](assets/wp-content/uploads/2019/02/02-create-code-768x590.png)

#### 3.2 The actual code

Our bot will reply to any telegram message with a “Hello _message-user-first-name”_

We are going to create a **router** function in order to be the single entry point for all telegram messages.

<figure class="embed embed--codepen"><iframe src="https://codepen.io/pikilon/pen/ErqQLG?default-tab=js" title="Simple Firebase Cloud Telegram Bot" loading="lazy" height="798" allowfullscreen></iframe><figcaption>Simple Firebase Cloud Telegram Bot — <a href="https://codepen.io/pikilon/pen/ErqQLG">ver en CodePen</a></figcaption></figure>

#### 3.3 Deploy your code

Now that you have create your bot code you need to upload it to firebase to be compiled and available

- In the **root** of your project run: **firebase deploy only –functions**

- Wait until the process finish and **write down the router function url**: in our case https://us-central1-**firebase**-bot.cloudfunctions.net/router

![](assets/wp-content/uploads/2019/02/04-deploy-cloud-function-e1552503772847-768x545.png)

## 4. Bind the bot to Firebase

Now you have the bot, you have your firebase cloud function running, you only need to connect them.

- Go to your browser and put the bold text with your data, we have defined TOKEN in 1.4.2) and the url in 3.3.2 **MAIN LAST “/”**
- https://api.telegram.org/bot**LONG_STRING_TOKEN**/setWebhook?url=https://us-central1-**firebase-bot**.cloudfunctions.net/router**/**

- Check is set correctly going to https://api.telegram.org/bot**LONG_STRING_TOKEN** /getWebhookInfo

![](assets/wp-content/uploads/2019/02/05-binded-768x383.png)

_Telegram bot and firebase binded_

## 5. Check the results

Let see it in action!
Open your bot in telegram and say hello to your creation

![](assets/wp-content/uploads/2019/02/06-result-128x109.png)

_Voilá_
