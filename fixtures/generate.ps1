# Generates test fixtures: a printed question paper and a "handwritten" answer sheet.
# The answer sheet deliberately exercises the hard cases: answers out of printed
# order, a question left unanswered, an answer that matches no question, and an
# answer that runs across a page break.

Add-Type -AssemblyName System.Drawing

$outDir = $PSScriptRoot

function New-Page {
    param([int]$Width = 1240, [int]$Height = 1754)
    $bmp = New-Object System.Drawing.Bitmap($Width, $Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::White)
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    return @{ Bitmap = $bmp; Graphics = $g; Width = $Width; Height = $Height }
}

function Write-Wrapped {
    param($Page, [string]$Text, $Font, $Brush, [int]$X, [int]$Y, [int]$MaxWidth, [int]$LineHeight)
    $words = $Text -split ' '
    $line = ""
    $cursorY = $Y
    foreach ($w in $words) {
        $test = if ($line -eq "") { $w } else { "$line $w" }
        $size = $Page.Graphics.MeasureString($test, $Font)
        if ($size.Width -gt $MaxWidth -and $line -ne "") {
            $Page.Graphics.DrawString($line, $Font, $Brush, $X, $cursorY)
            $cursorY += $LineHeight
            $line = $w
        } else {
            $line = $test
        }
    }
    if ($line -ne "") {
        $Page.Graphics.DrawString($line, $Font, $Brush, $X, $cursorY)
        $cursorY += $LineHeight
    }
    return $cursorY
}

# ---------------- Question paper ----------------

$qFont     = New-Object System.Drawing.Font("Times New Roman", 15)
$qNumFont  = New-Object System.Drawing.Font("Times New Roman", 15, [System.Drawing.FontStyle]::Bold)
$hdrFont   = New-Object System.Drawing.Font("Times New Roman", 20, [System.Drawing.FontStyle]::Bold)
$subFont   = New-Object System.Drawing.Font("Times New Roman", 12, [System.Drawing.FontStyle]::Italic)
$black     = [System.Drawing.Brushes]::Black

$questions = @(
    @{ n = "1";  s = "";  t = "Which blood vessel carries blood away from the heart?"; m = "[2]" },
    @{ n = "2";  s = "";  t = "Which of the following organelles is primarily involved in photosynthesis?"; m = "[2]" },
    @{ n = "3";  s = "";  t = "Explain the role of chloroplasts in photosynthesis, naming the main pigments involved and briefly outlining the two major stages of the process."; m = "[5]" },
    @{ n = "4";  s = "";  t = "Describe the flow of blood through the human heart starting from the right atrium and ending at the aorta; include the names of valves crossed."; m = "[5]" },
    @{ n = "5";  s = "";  t = "Describe the process of transpiration in plants in two to three sentences and name two environmental factors that increase its rate."; m = "[4]" },
    @{ n = "6";  s = "";  t = "Explain how the structure of xylem vessels facilitates water transport in plants (mention one structural feature and its role)."; m = "[3]" },
    @{ n = "7";  s = "a"; t = "A diagram shows two potted plants. Plant A in bright light with broad green leaves, Plant B kept in dim light with pale, elongated leaves. Explain why Plant B looks different."; m = "[3]" },
    @{ n = "7";  s = "b"; t = "Suggest one practical measure to help Plant B recover."; m = "[2]" },
    @{ n = "8";  s = "";  t = "A resting person has a tidal volume of 0.5 L and breathes 12 times per minute. If dead space is 0.15 L per breath, calculate the alveolar ventilation per minute. Show your working."; m = "[4]" }
)

$page = New-Page
$page.Graphics.DrawString("Class 10 - Biology Unit Test", $hdrFont, $black, 90, 70)
$page.Graphics.DrawString("Time: 1 hour", $subFont, $black, 90, 108)
$page.Graphics.DrawString("Answer all questions. Marks are shown in brackets.", $subFont, $black, 90, 130)
$page.Graphics.DrawLine([System.Drawing.Pens]::Black, 90, 160, 1150, 160)

$y = 200
$pageNo = 1
foreach ($q in $questions) {
    if ($y -gt 1560) {
        $page.Bitmap.Save((Join-Path $outDir "question_paper_p$pageNo.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        $page.Graphics.Dispose(); $page.Bitmap.Dispose()
        $pageNo++
        $page = New-Page
        $y = 120
    }

    $label = if ($q.s -ne "") { "$($q.n) ($($q.s))" } else { "$($q.n)." }
    $page.Graphics.DrawString($label, $qNumFont, $black, 90, $y)
    $y = Write-Wrapped -Page $page -Text "$($q.t) $($q.m)" -Font $qFont -Brush $black -X 175 -Y $y -MaxWidth 940 -LineHeight 30
    $y += 24
}
$page.Bitmap.Save((Join-Path $outDir "question_paper_p$pageNo.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$page.Graphics.Dispose(); $page.Bitmap.Dispose()
Write-Output "Question paper: $pageNo page(s)"

# ---------------- Answer sheet ----------------
# Written out of order (5 before 3), question 6 skipped entirely, an unrelated
# note that answers nothing, and answer 8 continuing onto page 2.

$handFont = New-Object System.Drawing.Font("Ink Free", 20)
if ($handFont.Name -ne "Ink Free") {
    $handFont = New-Object System.Drawing.Font("Segoe Script", 18)
}
$handLabel = New-Object System.Drawing.Font($handFont.Name, 20, [System.Drawing.FontStyle]::Bold)
$blue = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(30, 40, 120))

$answersP1 = @(
    @{ l = "Q1"; t = "The artery carries blood away from the heart. The aorta is the largest artery and it carries oxygenated blood to the body." },
    @{ l = "Q2"; t = "The chloroplast is the organelle involved in photosynthesis. It contains chlorophyll which traps sunlight." },
    @{ l = "Q5"; t = "Transpiration is the loss of water vapour from the leaves of a plant through the stomata. It pulls water up from the roots. Two factors that increase the rate are high temperature and windy conditions." },
    @{ l = "Q3"; t = "Chloroplasts contain chlorophyll a and chlorophyll b which absorb light. The two stages are the light reaction which happens in the thylakoid and makes ATP, and the Calvin cycle in the stroma which fixes carbon dioxide into glucose." },
    @{ l = "Q7 a"; t = "Plant B was kept in dim light so it could not make enough food. It grew tall and pale because it was stretching towards the light and had less chlorophyll." },
    @{ l = "Q7 b"; t = "Move Plant B to a bright window so it gets enough sunlight." }
)

$answersP2 = @(
    @{ l = "Q4"; t = "Blood enters the right atrium from the vena cava. It goes through the tricuspid valve into the right ventricle, then out the pulmonary valve to the lungs. It comes back to the left atrium, through the bicuspid valve into the left ventricle and out through the aortic valve into the aorta." },
    @{ l = "Note"; t = "Remember to revise the diagram of the nephron before the next test." },
    @{ l = "Q8"; t = "Tidal volume = 0.5 L, dead space = 0.15 L. So fresh air per breath = 0.5 - 0.15 = 0.35 L." }
)

$answersP3 = @(
    @{ l = ""; t = "Continuing Q8: alveolar ventilation = 0.35 x 12 = 4.2 L per minute." }
)

function Write-AnswerPage {
    param($Answers, [string]$FileName, [switch]$WithHeader)

    $p = New-Page
    $y = 100
    if ($WithHeader) {
        $p.Graphics.DrawString("Name: Priya S.    Roll No: 24", $handFont, $blue, 90, 60)
        $y = 150
    }

    foreach ($a in $Answers) {
        if ($a.l -ne "") {
            $p.Graphics.DrawString($a.l, $handLabel, $blue, 90, $y)
            $y += 42
        }
        $y = Write-Wrapped -Page $p -Text $a.t -Font $handFont -Brush $blue -X 130 -Y $y -MaxWidth 960 -LineHeight 46
        $y += 40
    }

    $p.Bitmap.Save((Join-Path $outDir $FileName), [System.Drawing.Imaging.ImageFormat]::Png)
    $p.Graphics.Dispose(); $p.Bitmap.Dispose()
}

Write-AnswerPage -Answers $answersP1 -FileName "answer_sheet_p1.png" -WithHeader
Write-AnswerPage -Answers $answersP2 -FileName "answer_sheet_p2.png"
Write-AnswerPage -Answers $answersP3 -FileName "answer_sheet_p3.png"

Write-Output "Answer sheet: 3 pages"
Write-Output "Handwriting font used: $($handFont.Name)"
