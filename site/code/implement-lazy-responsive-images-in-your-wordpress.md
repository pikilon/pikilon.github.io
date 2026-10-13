---
title: Implement Lazy Responsive images in your wordpress
slug: implement-lazy-responsive-images-in-your-wordpress
kind: post
date: 2015-12-14
status: published
category: code
tags: [Php, wp|wordpress, js|javascript, img|image]
summary: What are they?, can be used today?, How fast it going to become your website using them?
---

Webpages are read from top to bottom, and by bottom I mean the end of the whole content, even the one you are never going to see.

Video is the most bandwidth consumer in internet, but if you are in your phone, **the browser will protect you avoiding video “autoplay”,**but no with the images. So, sometimes, the browser will save your data plan avoiding play a 200 Kb background video, but it will be ok if the proud guy with the portfolio decided to put 30 Mb of images on a single page.

But because surely a lot of readers don’t give a damn about clients data plans I’ll say the magic words: Save bandwidth **is very good for SEO.** Less Mb = more speed loading = better ranking. Google knows that regular user is impatient and will hit “back” on a search result if takes long to load.

**What is a lazy image?** An image that will not download any data until is visible in the screen. Usually it’ll start to load when is closer to be seen, avoiding the wait to show up. So if you fill the site with hundreds of images it won’t matter until you scroll down. The browser doesn’t do it by itself so we’ll need a javascript solution.

We are saving a lot of data here, but it is not enough.

Very often you see a really big image in a very small screen. Imagine an slider with 5 images of 1200×700 px, and you are seen them in portrait mode in a 720×1280 screen, so in the end, you’ll  see five 720×420 images with 4 times more (surface) weight they should have.

EG: 600×600 images shown as 150×150, and some PNGs!

**What is a responsive image?** An image with a set of source files that will load the closer to the size is been seen. It is included in HTML5 and it can be coded in two ways, adding a **“srcset” attribute**to an <img> tab or use the HTML5 “picture” tag with different sources.  I am not going to repeat[the great article from Smashing magazine](http://www.smashingmagazine.com/2014/05/responsive-images-done-right-guide-picture-srcset/) with all the info you are gonna need.

It has one big annoying issue, you have to calculate (using media queries) which file to serve using mediaqueries, a good pain in the ass.

**Shouldn’t be great have one solution to have lazy images and auto-responsive-images?**  meet [lazysizes](https://github.com/aFarkas/lazysizes)

This great plugin allows you to release this feature today (take care, not IE8 supported).

So you want to use this on your WordPress theme, you don’t find the right plugin, and you want to learn how to do it, here you have what came with, put it on your functions.php o create a plugin, hope you like it!

<figure class="embed embed--gist"><a href="https://gist.github.com/e6f8a1f1397efa9019de">Gist e6f8a1f1397efa9019de</a><figcaption>Código completo en <a href="https://gist.github.com/e6f8a1f1397efa9019de">GitHub Gist</a></figcaption></figure>
