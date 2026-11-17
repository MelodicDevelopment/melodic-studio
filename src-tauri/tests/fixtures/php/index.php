<?php

require __DIR__ . '/src/Greeter.php';

use Fixture\Greeter;

$greeter = new Greeter();
echo $greeter->greet('world');
