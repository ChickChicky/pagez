# Pagez

Allows to declare pages and add a bit of post-processing to them.

# Usage

*(pages.np)*
```
(pages) { %%!auto
    root = "/"

    [/] { @"index.html" }
    [script.js] { @"script.js" }
    [style.css] { @"style.css" }
}
```

*(index.js)*
```js
const pagez = require('pagez');

const pages = pagez.parse(pagez.Source.fromFile('./pages.np'));

pages.build({
    decorators: {...pagez.builtinDecorators},
    macros: {...pagez.builtinMacros},
    sourcePath: 'source',
    outputPath: 'dist'
});
```

The above example would parse the pages file, store and minify the HTML and JS files from `source` in a dedicated `dist` folder.

We can also plug it into an HTTP server, which would look like this:

*(index.js)*
```js
const pagez = require('pagez');
const http = require('node:http');

const pages = pagez.parse(pagez.Source.fromFile('./pages.np'));

pages.build({
    decorators: {...pagez.builtinDecorators},
    macros: {...pagez.builtinMacros},
    sourcePath: 'source',
    outputPath: 'dist'
});

const server = http.createServer(
    ( req, res ) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const page = pages.getPage(url.pathname);
        if (page) {
            res.statusCode = 200;
            for (const [k,v] of Object.entries(page.page.props.__headers||{}))
                res.setHeader(k,v);
            res.end(page.body);
        } else {
            req.statusCode = 404;
            res.end();
        }
    }
);

server.listen(8080,'localhost',()=>console.log('Ready!'));
```

# Pagez Language (Nogis Pagez)

A namespace is denoted by parenthesis, and its body by curly braces:
```
(pages) {

}
```

Inside it may be properties, like the root path of the namespace:
```
(pages) {
    root = "/"
}
```

As well as pages, with their name denoted by square braces and their body by curly braces:
```
(pages) {
    root = "/"

    [/] {

    }
}
```

To indicate the path of the resource, we can use the @ symbol followed by the path between quotes:
```
(pages) {
    root = "/"

    [/] {
        @"index.html"
    }
}
```

But we might want to minimize it, and for this we can tag it with *min*:
```
(pages) {
    root = "/"

    %min
    [/] {
        @"index.html"
    }
}
```

While we're there, we could also want to tell the client what *kind* of ressource it is (not particularily useful here, but it might be in other cases):
```
(pages) {
    root = "/"

    %min
    %kind<"text/html">
    [/] {
        @"index.html"
    }
}
```

But, using only *kind* without giving it an argument will auto-detect which one it is based on the path's extension. Moreover, we can use the *auto* macro that does all of that:
```
(pages) {
    root = "/"

    %!auto
    [/] {
        @"index.html"
    }
}
```

But if there is a feature we wouldn't like to be applied we can use a dash to cancel it:
```
(pages) {
    root = "/"

    %!auto
    %-min
    [/] {
        @"index.html"
    }
}
```

And if we have multiple pages, we can place them in curly braces and put the decorators on top:
```
(pages) {
    root = "/"

    %!auto
    {
        [/] { @"index.html" }
        [script.js] { @"script.js" }
        [style.css] { @"style.css" }
    }
}
```

As we are applying *auto* to all of the pages, we can move it to the very top and add another *\`%\`* to signify it is global:
```
(pages) { %%!auto
    root = "/"

    [/] { @"index.html" }
    [script.js] { @"script.js" }
    [style.css] { @"style.css" }
}
```