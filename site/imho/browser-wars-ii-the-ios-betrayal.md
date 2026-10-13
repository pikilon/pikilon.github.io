---
title: Browser wars II: The iOS betrayal
slug: browser-wars-ii-the-ios-betrayal
kind: post
date: 2019-01-30
status: published
category: IMHO
tags: [html, react, native, flutter]
summary: React Native or Flutter are here to help you to create easily your App in iOS or Android (even web), using the same code and with an awesome performance. But there is only a little thing… The Golde…
featured: wp-content/uploads/2019/01/platform-wars.png
---

React Native or Flutter are here to help you to create easily your App in iOS or Android (even web),  using the same code and with an awesome performance. But there is only a little thing…

## The Golden years

Before the smartphones, after the reign of desktop applications we met the golden years of Web apps, web 2.0 was rising, and we found the UI [koiné](https://en.wikipedia.org/wiki/Koin%C3%A9_language): **HTML5 .**

If you wanted to develop an App for Windows, Linux, Mac and the first iPhone you wrote the interface in HTML and that works everywhere, HTML5 stole Java’s slogan: “[Write once, run anywhere](https://en.wikipedia.org/wiki/Write_once,_run_anywhere)“

> **The only thing you need** to develop an entire app was literally a **plain text editor**

We left behind the hard part of  the first browser war, yes, we had Internet Explorer 8 giving troubles, but jQuery helped a lot.
Browser fought for being the more standard compliant, they fought to add richer experiences, and, as always, they fought to be the fastest one.

In every device with a browser you had your app running, almos everywhere until…If you had a thing with a browser you browse your app there, and then…

## The iOS betrayal

There was no app store on the original iPhone, [It was meant to use HTML5 apps](https://9to5mac.com/2011/10/21/jobs-original-vision-for-the-iphone-no-third-party-native-apps/).

<figure class="wp-block-embed-youtube wp-block-embed is-type-video is-provider-youtube wp-embed-aspect-4-3 wp-has-aspect-ratio"><div class="wp-block-embed__wrapper"><iframe loading="lazy" title="Safari: iPhone Development Platform" width="525" height="394" src="https://www.youtube.com/embed/8Vq993Td6ys?feature=oembed" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div></figure>

The web was perfect, this was the excuse to not have support for Adobe Flash, fighting for the standards they say.

When the App store came Apple realized it was a gold mine, they could have a cut of any app working on the iPhone through the only available app source: **their store.**

Suddenly the good old HTML5 became an enemy to destroy, why support web apps with no Store fee? Let’s begin the boicot:

- No webWorkers until yesterday, and now [very cripple one with limitations](https://medium.com/@firt/progressive-web-apps-on-ios-are-here-d00430dee3a7#cafa) such as no push notifications, you can’t add the app to the list with a link, no touch id, no more than 50Mb, etc.

- Forget a workaround using third party browsers, they are forced to use the iOS engine with this limitations.

- For develop any app in iOS you will need an Apple device, just like that. You can emulate Android on Mac, but you can emulate iOS outside a Mac. You will need Xcode one way or the other.

> Regulations do their part to damage web app UX. Ignorants Politicians forced every web site to put a **cookie banner**, instead of encourage **private browser’s mode.**

## The false saviors

Oh gods! I wish to have something to code onces and deploy everywhere, web, iOS, Android, even desktop, with **performance**. Yes, the performance is the most important thing in your app, even if is a regular shop and your users will not notice the difference.

### React Native

 Using Javascript and React you will be able to deploy [literally everywhere](https://github.com/react-everywhere/re-start) and with a [theoretical performance 80% compared to native](https://medium.com/the-react-native-log/comparing-the-performance-between-native-ios-swift-and-react-native-7b5490d363e2).

But to be honest this is a lie. **You will make you choose** between having a bad app on 3 platforms or spend 3x more time to have consistency between them. Two graphic examples to show that even the browser wars was a child game compared to the inconsistencies:

- Styling
- Overflow-visible you can position text outside a box in iOS and web, but not in android.

- You will be forced to use [css-in-js](https://hackernoon.com/all-you-need-to-know-about-css-in-js-984a72d48ebc)that generate crappy css files for the web. I will talk (badly) about css-in-js in the future

- SVG (multicolor): iOS doesn’t support it, android and web does, you will have to install a plugin and face consistences.

You can read more reasons why is not a solution from former react native [fan AirBnB here.](https://medium.com/airbnb-engineering/sunsetting-react-native-1868ba28e30a)React Native: using Javascript and React you will be able to deploy [literally everywhere](https://github.com/react-everywhere/re-start)

### Flutter

Google has money, React is from Facebook, let’s try to beat the React Native hype.

With [Flutter](https://medium.com/asos-techblog/flutter-vs-react-native-for-ios-android-app-development-c41b4e038db9) you will code on Dart ([wikipedia link here](https://en.wikipedia.org/wiki/Dart_(programming_language))) and it will paint in a screen canvas your interface (less inconsistencies) and with great performance, they swear to get +15ms in rendering your kittens.

- Who wants to learn Dart, manage yaml packages and [flutter custom styling](https://flutter.io/docs/get-started/flutter-for/web-devs)? Tell your devs to start learning Dart to master it only for Flutter, or even worst tell a rookie to start with Dart language. Let’s everyone to learn [esperanto](https://en.wikipedia.org/wiki/Esperanto), it will be fun!

- No web currently, create another app in HTML5 or wait to the [experimental](https://medium.com/flutter-io/hummingbird-building-flutter-for-the-web-e687c2a023a8)becomes alpha.

## The silver bullet

![](https://imgs.xkcd.com/comics/installing.png)

_XKCD nailed again_

We want to have an App written with the same code, runs everywhere with UX consistency, with experience and support…what about HTML5? and you will only need a notepad and a browser to develop it.

If you (really) need **performance**to do some operations, first review your code and if this is not enough check out [webassembly](https://webassembly.org/)that offers up to 80% of native performance to make some heavy lifting. But really, check your code first.

If you need something like push notifications in your app, start small, give support to the good guys that don’t cripple the web: Android and Desktop. If your app has huge success and you need iOS support use a web wrapper like [Cordova](https://cordova.apache.org/). I wish you luck to deal with Apple bureaucracy  to publish your app.

And one last thing, web is open source, lots of developers has learned by right clicking the browser and inspecting the code. It was like open a hood of a car to see what was going on there. “How did this dev this that?”, “look he added this workaround to achive this effect”…

#### you can’t right click a native App
