<?php

namespace Fixture;

class Greeter
{
    /** Builds the line the fixture prints. */
    public function greet(string $name): string
    {
        return "Hello, {$name}!";
    }
}
